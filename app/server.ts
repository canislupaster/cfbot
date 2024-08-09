"use server"

import { Cheerio } from "cheerio";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import { ProxyAgent } from "undici";
import { APIError, AuthResult, HintType } from "./util";

import prox from "../proxies.json";
import { encoding_for_model } from "tiktoken";
import { auth } from "./auth";

let dispatchers: (ProxyAgent|undefined)[] = [undefined];
let waiters: (()=>void)[] = [];

function shuffle<T>(arr: T[]) {
	for (let i=1; i<arr.length; i++) {
		const j = Math.floor(Math.random()*(i+1));
		const x = arr[j];
		arr[j]=arr[i];
		arr[i]=x;
	}
}

console.log(`adding ${prox.length} proxies`);

for (const p of (prox as string[])) {
	const parts = p.split(":");
	if (parts.length!=2 && parts.length!=4)
		throw `expected 2 (host,port) or 4 parts (host,port,user,pass) for proxy ${p}`;
	dispatchers.push(new ProxyAgent({
		uri: `http://${parts[0]}:${parts[1]}`,
		token: parts.length==2 ? undefined : `Basic ${Buffer.from(`${parts[2]}:${parts[3]}`).toString('base64')}`
	}));
}

shuffle(dispatchers);

const dispatcherWait = 500, dispatcherErrorWait = 30_000;

export async function fetchDispatcher<T>(transform: (r: Response) => Promise<T>, ...args: Parameters<typeof fetch>): Promise<T> {
	let err: any;
	for (let retryI=0; retryI<5; retryI++) {
		while (dispatchers.length==0) {
			await new Promise<void>((res,rej) => waiters.push(res));
		}

		const d = dispatchers.pop();
		let wait = dispatcherWait;

		try {
			const hdrs = new Headers({...args[1]?.headers});
			// hdrs.append("User-Agent", userAgent);

			const resp = await fetch(args[0], {
				...args[1],
				//@ts-ignore
				dispatcher: d,
				headers: hdrs
			});

			if (resp.status==429 && resp.headers.has("Retry-After")) {
				const waitTime = Number.parseFloat(resp.headers.get("Retry-After")!)*1000;
				await new Promise<void>((res,rej)=>setTimeout(res, waitTime));
				continue;
			}

			return await transform(resp);
		} catch (e) {
			err=e;
			wait = dispatcherErrorWait;
			continue;
		} finally {
			setTimeout(() => {
				dispatchers.push(d);
				const w = waiters.shift();
				if (w!==undefined) w();
			}, wait);
		}
	}

	console.error(err);
	throw new APIError("failed", "Ran out of retries trying to fetch data");
}

async function getHTML(url: string|URL, qparams: Record<string,string>={}) {
	const u = new URL(url);
	for (const [k,v] of Object.entries(qparams))
		u.searchParams.append(k,v);
	return await fetchDispatcher((resp)=>{
		if (resp.status!=200) throw resp.statusText;
		return resp.text().then(x=>cheerio.load(x));
	}, u);
}

async function getEditorial(contest: string, index: string) {
	const re = /^[A-Za-z0-9]+$/;
	if (contest.match(re)==null || index.match(re)==null)
		throw new APIError("problemNotFound", "Invalid contest/problem index");

	const prob = await getHTML(`https://codeforces.com/problemset/problem/${contest}/${index}`);

	const probStatement = prob(".problem-statement > div:not(.header,.input-specification,.output-specification,.sample-tests,.note)").html()
	
	let out:string|null=null;
	for (const box of prob(".roundbox.sidebox").toArray()) {
		if (prob(box).find(".caption.titled").text().includes("Contest materials")) {
			for (const link of prob(box).find("li a").toArray()) {
				const title = link.attribs["title"]??"", txt=prob(link).text(), href=link.attribs["href"]??"";
				const search = `${title}\n${txt}`.toLowerCase();
				if (["editorial", "tutorial"].some(x=>search.includes(x))
					&& href.match(/^(https:\/\/codeforces\.com)?\/blog\/entry\/\d+$/)!=null) {

					out=link.attribs["href"]??null;
					break;
				}
			}
		}
	}

	if (out==null)
		throw new APIError("editorialNotFound", "link to editorial not found in problem");

	const edit = await getHTML(new URL(out, "https://codeforces.com"));
	const elems = edit(".content > .ttypography").find("b,p,a,ul,li,code").toArray();
	
	const probLinkRe = /^(?:https:\/\/codeforces\.com)?\/contest\/(\w+)\/problem\/(\w+)$/;
	let txt=[], inprob=false;
	for (const el of elems) {
		const href = el.attribs["href"]?.match(probLinkRe);
		if (el.name=="a" && href!=null) {
			if (href[1]==contest && href[2]==index) inprob=true;
			else inprob=false;
		} else if (inprob) {
			const content = edit(el).html();
			if (content!=null && content.length>0)
				txt.push(content);
		}
	}

	if (txt.length==0)
		throw new APIError("editorialNotFound", "problem not mentioned in editorial");
	return {
		editorial: txt.join("\n\n"),
		statement: probStatement?.trim() ?? null
	};
}

type Problem = {
	contestId: number;
	index: string;
	name: string;
	rating?: number;
	tags: string[];
};

type ProblemSet = {
	problems: Problem[];
};

let problemSet: ProblemSet|null=null;

async function getProblemSet() {
	if (problemSet==null) problemSet=await fetchDispatcher(async (r)=>{
		const j = await r.json();
		if (j.status != "OK") throw new APIError("failed", `CF API Error: ${j.comment}`);
		return j.result;
	}, "https://codeforces.com/api/problemset.problems") as ProblemSet;

	return problemSet;
}

const openai = new OpenAI();

export async function getProblemNames() {
	return (await getProblemSet()).problems.map(x=>`${x.contestId}${x.index}`);
}

const MAX_OUT_TOKEN = 512;
const MAX_IN_TOKEN = 8192;
const MODEL = "gpt-4o-mini";

const enc = encoding_for_model("gpt-4o");

export async function getHint(type: HintType, contest: string, index: string, prompt: string): Promise<Exclude<AuthResult, {type: "success"}>|{type: "success", result: string, tokens: number|null}> {
	const authRes = await auth();
	if (authRes.type!="success") return authRes;

	const problemSetSearch = new Map((await getProblemSet()).problems.map(
		x=>[`${x.contestId}\n${x.index}`.toLowerCase(),x]));
	const prob = problemSetSearch.get(`${contest}\n${index}`.toLowerCase());
	if (prob==undefined) throw new APIError("problemNotFound", "not in problemset");

	const edit = await getEditorial(prob.contestId.toString(), prob.index);

	let hintStr: string, hintDesc:string|null=null;
	switch (type) {
		case "big": hintStr="big"; hintDesc="Give specifics and reveal major insights."; break;
		case "medium":
			hintStr="medium";
			hintDesc="Help the user overcome their roadblock, but reveal as little as possible.";
			break;
		case "small":
			hintStr="small";
			hintDesc="Give a subtle push in the right direction, without any specifics. Make a suggestion, but do not directly reveal any steps, insights, or ideas in the solution."
			break;
		case "oneWord": hintStr="one word"; break;
		case "yesNo": hintStr="yes or no"; break;
		default: throw new APIError("failed", `unknown hint type ${type}`);
	}

	const key = `${type}Hint`;

	const system = `You will provide a **${hintStr}** hint to a Codeforces problem given the content of the editorial (including hints, solutions, and code).${hintDesc==null ? "" : ` ${hintDesc}`} In this case, the problem is ${prob.contestId}${prob.index} - ${prob.name}.${prob.tags.length>0 ? ` It is tagged ${
		prob.tags.join(", ")}.`:""
	}${
		edit.statement!=null ? `\nProblem statement:\n${edit.statement}` : ""
	}\nEditorial content:\n${edit.editorial}`;

	const inputTokens=enc.encode_ordinary(`${prompt}\n${edit}`).length;
	if (inputTokens>MAX_IN_TOKEN)
		throw new APIError("failed", `Exceeded ${MAX_IN_TOKEN} input tokens`);
		
	const completion = await openai.chat.completions.create({
		max_tokens: MAX_OUT_TOKEN,
		messages: [{
			role: "system",
			content: system
		}, {
			role: "user",
			content: prompt
		}],
		model: MODEL,
		response_format: {
			type: "json_schema",
			json_schema: {
				name: "hint_reasoning",
				description: `Enter your hint here. Use explanation to decide what to reveal in your hint and ensure the accuracy of your hint, then enter your ${hintStr} hint in ${key}.`,
				schema: {
					type: "object",
					properties: {
						explanation: {type: "string"},
						[key]: {type: "string"}
					},
					required: ["explanation",key],
					additionalProperties: false
				},
				strict: true
			}
		}
	});

	const msg = completion?.choices?.[0]?.message;
	if (msg?.refusal!=null) throw new APIError("refusal", msg.refusal);
	if (msg?.content==null) throw new APIError("failed", "no content");

	let out = JSON.parse(msg.content)[key];
	if (typeof out !== "string") throw new APIError("failed", "invalid json from model response");

	out=out.trim();
	if (out.length==0)
		throw new APIError("refusal", "Model did not provide a nonempty response");

	const words = out.split(/\s+/g);
	if ((type=="oneWord" || type=="yesNo") && words.length!=1)
		throw new APIError("refusal", "Model did not provide a one-word response");
	if (type=="yesNo" && !["yes","no"].includes(words[0].toLowerCase()))
		throw new APIError("refusal", "Model did not provide a yes/no response");
	
	return {
		type: "success",
		result: type=="yesNo" ? words[0].toLowerCase() : out,
		tokens: completion.usage?.total_tokens ?? null
	};
}