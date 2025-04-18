"use server"

import * as cheerio from "cheerio";
import OpenAI from "openai";
import { ProxyAgent } from "undici";
import { APIError, apiRes, AuthFailure, HintResult, HintType, LoginInfo } from "./util";

import prox from "../proxies.json";
import { encoding_for_model, Tiktoken } from "tiktoken";
import { updateCost, auth, DBUser, inDiscord } from "./auth";

const dispatchers: (ProxyAgent|undefined)[] = [];
const waiters: (()=>void)[] = [];
const mainWaiters: (()=>void)[] = [];

function shuffle<T>(arr: T[]) {
	for (let i=1; i<arr.length; i++) {
		const j = Math.floor(Math.random()*(i+1));
		const x = arr[j];
		arr[j]=arr[i];
		arr[i]=x;
	}
}

let proxArr: string[];
if ("proxyFetchUrl" in prox) {
	console.log("fetching proxies...");
	proxArr = (await (await fetch(prox.proxyFetchUrl)).text()).trim().split("\n");
} else {
	proxArr = prox;
}

console.log(`adding ${proxArr.length} proxies`);

for (const p of proxArr) {
	const parts = p.split(":");
	if (parts.length!=2 && parts.length!=4)
		throw new Error(`expected 2 (host,port) or 4 parts (host,port,user,pass) for proxy ${p}`);
	dispatchers.push(new ProxyAgent({
		uri: `http://${parts[0]}:${parts[1]}`,
		token: parts.length==2 ? undefined : `Basic ${Buffer.from(`${parts[2]}:${parts[3]}`).toString('base64')}`
	}));
}

shuffle(dispatchers);
let mainReady=true;

const dispatcherWait = 500, dispatcherErrorWait = 30_000, timeout=10_000;
const waiterLimit = 25;

export type FetchOpts = {
	noproxy?: boolean,
	nocache?: boolean
};

export async function fetchDispatcher<T>({noproxy, nocache}: FetchOpts, transform: (r: Response) => Promise<T>, ...args: Parameters<typeof fetch>): Promise<T> {
	let err: any;
	for (let retryI=0; retryI<5; retryI++) {
		let d: ProxyAgent|undefined=undefined;

		if ((noproxy && mainWaiters.length>=waiterLimit) || (!noproxy && waiters.length>=waiterLimit))
			throw new APIError("failed", "We're too far backed up right now! Come back later.");

		if (noproxy) {
			while (!mainReady)
				await new Promise<void>((res,rej) => mainWaiters.push(res));
		} else {
			while (dispatchers.length==0 && !mainReady) {
				await new Promise<void>((res,rej) => waiters.push(res));
			}

			if (dispatchers.length>0) d=dispatchers.pop();
		}

		if (d===undefined) mainReady=false;

		let wait = dispatcherWait;

		try {
			const hdrs = new Headers({...args[1]?.headers});
			// hdrs.append("User-Agent", userAgent);

			console.log("fetching", args[0]);
			const resp = await fetch(args[0], {
				...args[1],
				//@ts-ignore
				dispatcher: d,
				cache: nocache ? "no-cache" : undefined,
				next: nocache ? undefined : {revalidate: 3600},
				headers: hdrs,
				signal: AbortSignal.timeout(timeout)
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
				if (d===undefined) mainReady=true;
				else dispatchers.push(d);

				const mw = mainWaiters.shift();
				if (mw!==undefined) mw();
				else {
					const w = waiters.shift();
					if (w!==undefined) w();
				}
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
	return await fetchDispatcher({}, (resp)=>{
		if (resp.status!=200) throw resp.statusText;
		return resp.text().then(x=>cheerio.load(x));
	}, u);
}

async function getEditorial(contest: string, index: string) {
	const re = /^[A-Za-z0-9]+$/;
	if (contest.match(re)==null || index.match(re)==null)
		throw new APIError("problemNotFound", "Invalid contest/problem index");

	const prob = await getHTML(`https://codeforces.com/problemset/problem/${contest}/${index}`);

	const probStatementEl = prob(".problem-statement > div:not(.header,.input-specification,.output-specification,.sample-tests,.note)");
	//strip attributes
	probStatementEl.find("*").each((i,el)=>{el.attribs={};});
	const probStatement=probStatementEl.children().html();
	
	let out:string|null=null;
	for (const box of prob(".roundbox.sidebox").toArray()) {
		if (prob(box).find(".caption.titled").text().includes("Contest materials")) {
			for (const link of prob(box).find("li a").toArray()) {
				const title = link.attribs["title"]??"", txt=prob(link).text(), href=link.attribs["href"]??"";
				const search = `${title}\n${txt}`.toLowerCase();
				if ((["editorial", "tutorial"].some(x=>search.includes(x)) || title.trim()=="T")
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
			edit(el).add(edit(el).find("*")).each((i,el)=>{el.attribs={};});
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
	if (problemSet==null) problemSet=await fetchDispatcher({nocache: true}, async (r)=>{
		const j = await r.json();
		if (j.status != "OK") throw new APIError("failed", `CF API Error: ${j.comment}`);
		return j.result;
	}, "https://codeforces.com/api/problemset.problems") as ProblemSet;


	return problemSet;
}

const openai = new OpenAI();

export const getProblemNames = apiRes(async ()=>{
	return (await getProblemSet()).problems.map(x=>`${x.contestId}${x.index}`);
});

type Model = "gpt-4o-mini"|"o1-mini";
type UserLimits = {
	model: Model,
	maxCents: number
};

type ModelInfo = {
	maxOutToken: number,
	maxInToken: number,
	inputCents: number,
	outputCents: number,
	encoding: Tiktoken
};

const CREDIT_TIME = 24*3600*1000*3; //3 days, in ms

const modelInfo: Record<Model, ModelInfo> = {
	"gpt-4o-mini": {
		maxOutToken: 512,
		maxInToken: 8192,
		inputCents: 15/1e6,
		outputCents: 60/1e6,
		encoding: encoding_for_model("gpt-4o-mini"),
	},
	"o1-mini": {
		maxOutToken: 1024,
		maxInToken: 8192,
		inputCents: 300/1e6,
		outputCents: 12*100/1e6,
		encoding: encoding_for_model("o1-mini")
	}
} as const;

const userLimits = {
	poor: {
		model: "gpt-4o-mini",
		maxCents: 3
	} satisfies UserLimits,
	rich: {
		model: "o1-mini",
		maxCents: 10
	} satisfies UserLimits,
} as const;

const userLock = new Set<number>();

async function getLimits(user: DBUser) {
	return await inDiscord(user.discordId) ? userLimits.rich : userLimits.poor;
}

type Usage = {
	tokens: number, cents: number
};

async function runCompletion(user: DBUser, outUsage: Usage, model: Model, msgs: OpenAI.ChatCompletionMessageParam[], schema?: OpenAI.ResponseFormatJSONSchema["json_schema"]) {
	const info = modelInfo[model];

	const inputTokens = info.encoding.encode_ordinary(msgs.map(x=>x.content??"").join("\n")).length;
	if (inputTokens>info.maxInToken)
		throw new APIError("failed", `Exceeded ${info.maxInToken} input tokens when reprocessing model output with gpt-4o-mini`);

	const completion = await openai.chat.completions.create({
		max_completion_tokens: info.maxOutToken,
		messages: msgs,
		model: model,
		response_format: schema ? {
			type: "json_schema",
			json_schema: schema
		} : { type: "text" }
	});

	const usage = completion.usage;
	const cost = usage==null ? 0 : info.inputCents*usage.prompt_tokens + info.outputCents*usage.completion_tokens;

	if (cost>0) {
		const expired = user.costStart==null || user.costStart<Date.now()-CREDIT_TIME;
		const start = user.costStart==null || expired ? Date.now() : user.costStart;
		await updateCost(user, (expired ? 0 : user.cost)+cost, start);
	}

	if (usage) {
		outUsage.tokens+=usage.total_tokens;
		outUsage.cents+=cost;
	}

	const msg = completion?.choices?.[0]?.message;
	if (msg?.refusal!=null) throw new APIError("refusal", msg.refusal);
	if (msg?.content==null) throw new APIError("failed", "no content");

	return msg.content;
}

async function complete(type: HintType, contest: string, index: string, prompt: string, user: DBUser) {
	const limits = await getLimits(user);
	if (user.costStart!=null && user.costStart>=Date.now()-CREDIT_TIME && user.cost>limits.maxCents)
		throw new APIError("overusage", `Your usage will reset around (sorry too lazy to convert timezones :}) ${new Date(user.costStart+CREDIT_TIME).toDateString()}`);

	const problemSetSearch = new Map((await getProblemSet()).problems.map(
		x=>[`${x.contestId}\n${x.index}`.toLowerCase(),x]));
	const prob = problemSetSearch.get(`${contest}\n${index}`.toLowerCase());
	if (prob==undefined) throw new APIError("problemNotFound", "not in problemset");

	const edit = await getEditorial(prob.contestId.toString(), prob.index);

	const hasPrompt = prompt.trim().length>0;
	let hintStr: string, hintDesc:string|null=null;
	switch (type) {
		case "big": hintStr="big"; hintDesc=`Give specifics and reveal major insights.${hasPrompt ? " Fully address the user's question." : ""}`; break;
		case "medium":
			hintStr="medium";
			hintDesc="Help the user overcome a small roadblock, but reveal as little as possible.";
			break;
		case "small":
			hintStr="small";
			hintDesc=`Give a subtle push in the right direction, without any specifics. ${hasPrompt ? "Answer the question" : "Make a suggestion"}, but do not directly reveal any steps, insights, or ideas in the solution.`
			break;
		case "oneWord": hintStr="one word"; break;
		case "yesNo": hintStr="yes or no"; break;
		case "complexity":
			hintStr="runtime complexity";
			hintDesc="Extract the runtime (or, if the user requests, memory) complexity from the editorial. Do not give anything else away. Format as display math.";
			break;
		default: throw new APIError("failed", `unknown hint type ${type}`);
	}

	const key = `${type}Hint`;

	const system = `Please provide a **${hintStr}** hint to a Codeforces problem given the content of the editorial (including hints, solutions, and code).${hintDesc==null ? "" : ` ${hintDesc}`} The problem is ${prob.contestId}${prob.index} - ${prob.name}.${prob.tags.length>0 ? ` It is tagged ${
		prob.tags.join(", ")}.`:""
	}${prob.rating!=null ? ` It is rated ${prob.rating}.` : ""}`;

	const msgs: OpenAI.ChatCompletionMessageParam[] = [
		{ role: limits.model=="o1-mini" ? "user" : "system", content: system }
	];
	
	if (edit.statement!=null) {
		msgs.push({
			role: "assistant",
			content: "What is the problem statement?"
		});

		msgs.push({
			role: "user",
			content: edit.statement
		});
	}

	msgs.push({
		role: "assistant",
		content: "What is the editorial solution?"
	});

	msgs.push({
		role: "user",
		content: edit.editorial
	});

	if (hasPrompt) {
		msgs.push({
			role: "assistant",
			content: "What do you want to know about the solution?"
		});

		msgs.push({
			role: "user",
			content: prompt
		});
	}

	const noCode = ["yesNo","small","oneWord"].includes(type);
	const schema = {
		name: "hint_reasoning",
		schema: {
			type: "object",
			properties: {
				explanation: {
					type: "string",
					description: `Explain what you think you should reveal in your hint and verify the accuracy of your hint.${hasPrompt ? " Also, carefully confirm the relevance of your hint to the user's question." : ""}`
				},
				[key]: {
					type: "string",
					description: `Enter your ${hintStr} hint here. You may use ${"`"}inline code blocks${"`"}, $inline math$ and $$block math$$ (rendered with KaTeX). If you are uncertain or your hint is not directly reported in the editorial, make that clear here.`
				},
				code: noCode ? undefined : {
					type: ["object","null"],
					properties: {
						source: {type: "string"},
						language: {
							type: "string",
							description: "Short language identifier (e.g. cpp, python, js)"
						}
					},
					required: ["source", "language"],
					additionalProperties: false,
					description: `You may include code with your ${hintStr} hint here at your discretion. Do not include code if it's not requested by the user.`
				}
			},
			required: ["explanation",key,...(noCode ? [] : ["code"])],
			additionalProperties: false
		},
		strict: true
	} as const;

	const outUsage: Usage = {tokens: 0, cents: 0};
	const content = await runCompletion(user, outUsage, limits.model, msgs,
		limits.model=="gpt-4o-mini" ? schema : undefined);

	let out;
	if (limits.model=="gpt-4o-mini") {
		out = JSON.parse(content);
	} else {
		console.log(content);
		const system2 = `Please provide a ${hintStr} hint to a Codeforces problem.${hintDesc==null ? "" : ` ${hintDesc}`}`;

		const msgs2: OpenAI.ChatCompletionMessageParam[] = [
			{ role: "system", content: system2 },
			{ role: "user", content: prompt },
			{ role: "assistant", content: content },
			{ role: "user", content: "Please reformat this hint in the given output format" }
		];

		out = JSON.parse(await runCompletion(user, outUsage, "gpt-4o-mini", msgs2, schema));
	}

	console.log(out.explanation);
	if (typeof out[key] !== "string") throw new APIError("failed", "invalid json from model response");

	out[key]=out[key].trim();
	if (out.length==0)
		throw new APIError("refusal", "Model did not provide a nonempty response");

	const words = out[key].split(/\s+/g);
	if ((type=="oneWord" || type=="yesNo") && words.length!=1)
		throw new APIError("refusal", "Model did not provide a one-word response");
	if (type=="yesNo" && !["yes","no"].includes(words[0].toLowerCase()))
		throw new APIError("refusal", "Model did not provide a yes/no response");
	
	return {
		type: "success",
		result: type=="yesNo" ? words[0].toLowerCase() : out[key],
		code: noCode ? null : (out.code ?? null),
		usage: outUsage
	} as const;
}

export const getHint = apiRes(
	async (type: HintType, contest: string, index: string, prompt: string):
		Promise<AuthFailure|({type: "success"}&HintResult)> => {

	const authRes = await auth();
	if (authRes.type!="success") return authRes;

	const user = authRes.user;

	if (userLock.has(user.id))
		throw new APIError("failed", "A completion is already in progress.");

	userLock.add(user.id);
	try {
		return await complete(type,contest,index,prompt,user);
	} finally {
		userLock.delete(user.id);
	}
});

export async function getLoginInfo(user: DBUser) {
	const limits = await getLimits(user);
	return {
		discordUsername: user.discordUsername,
		cents: user.cost, maxCent: limits.maxCents,
		resetTime: user.costStart && user.costStart+CREDIT_TIME>Date.now() ? user.costStart+CREDIT_TIME : null,
		model: limits.model.replaceAll("gpt", "GPT")
	} satisfies LoginInfo;
}

export const loginInfo = apiRes(async ()=>{
	const authed = await auth();
	if (authed.type!="success") return null;
	return getLoginInfo(authed.user);
});
