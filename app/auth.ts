"use server"

import { cookies } from 'next/headers'
import {default as knexConstructor} from "knex"
import { createHash, randomBytes, randomUUID } from "crypto";
import { fetchDispatcher } from "./server";
import { AuthResult, ROOT_URL, Unauthorized } from "./util";

const knex = knexConstructor({
	client: "better-sqlite3",
	connection: { filename: "./db.sqlite" },
	useNullAsDefault: false
});

type DBSession = {id: string, key: Buffer, user: number|null, created: number};
type DBUser = {id: number, discordId: string, discordUsername: string};

const SESSION_EXPIRE = 3600*24*10; //seconds

function hash(s: string): Buffer {
	const h = createHash("sha256");
	h.update(s);
	return h.digest();
}

async function session() {
	const jar = cookies();
	const ses=jar.get("session"), key=jar.get("key");
	if (ses!=undefined && key!=undefined) {
		const sesData = await knex<DBSession>("session").select()
			.where({id: ses.value}).first();
		if (sesData!=undefined && hash(key.value).equals(sesData.key)
			&& Date.now()-sesData.created<SESSION_EXPIRE) {
			return {id: sesData.id, user: sesData.user??null};
		}
	}

	const id=randomUUID(), k = randomBytes(20).toString("base64");

	await knex<DBSession>("session").insert({
		id, key: hash(k), created: Date.now(), user: null
	});

	jar.set("session", id, {secure: true, httpOnly: true});
	jar.set("key", k, {secure: true, httpOnly: true});
	return {id, user: null};
}

async function getUser(userId: number) {
	return (await knex<DBUser>("user").select().where({id: userId}).first()) ?? null;
}

const DISCORD_CLIENT = process.env["DISCORD_CLIENT"]!;
const DISCORD_SECRET = process.env["DISCORD_SECRET"]!;
const DISCORD_TOKEN = process.env["DISCORD_TOKEN"]!;
const DISCORD_GUILD = process.env["DISCORD_GUILD"]!;

async function inDiscord(discordId: string) {
	return await fetchDispatcher(async r=>{
		if (r.status==404) return false;
		else if (r.status==200) return true;
		else throw r.statusText;
	},
	`https://discord.com/api/guilds/${DISCORD_GUILD}/members/${discordId}`, {
		headers: { Authorization: `Bot ${DISCORD_TOKEN}` }
	});
}

export async function auth(): Promise<AuthResult> {
	const ses = await session();
	const redir = new URL("https://discord.com/oauth2/authorize");
	const params: Record<string,string> = {
		client_id: DISCORD_CLIENT,
		redirect_uri: ROOT_URL,
		response_type: 'code',
		scope: 'identify',
		state: ses.id
	};
	
	redir.search = new URLSearchParams(params).toString();

	const did = ses.user==null ? null : (await getUser(ses.user))?.discordId;
	if (ses.user==null || did==null) return {type: "login", redirect: redir.href};
	if (!(await inDiscord(did)))
		return {type: "notInDiscord", redirect: redir.href};

	return {type: "success"};
}

export async function exchangeCode(code: string, state: string) {
	const ses = await session();
	if (state!==ses.id) throw new Unauthorized("Bad state");

	const token = await fetchDispatcher(r=>r.json(), "https://discord.com/api/oauth2/token", {
		method: "POST",
		body: new URLSearchParams({
			client_id: DISCORD_CLIENT,
			client_secret: DISCORD_SECRET,
			code,
			grant_type: 'authorization_code',
			redirect_uri: ROOT_URL,
			scope: 'identify',
		}).toString(),
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		}
	});

	if (typeof token.access_token !== "string")
		throw new Unauthorized("Failed to retrieve access token.");

	const user = await fetchDispatcher(r=>r.json(), 'https://discord.com/api/users/@me', {
		headers: { authorization: `Bearer ${token.access_token}` },
	});

	if (typeof user.id !== "string" || typeof user.username !== "string")
		throw new Unauthorized("Failed to retrieve user info.");

	const userId = (await knex<DBUser>("user").insert({
		discordId: user.id,
		discordUsername: user.username
	})
		.onConflict("discordId").merge().returning("id"))[0];
	if (userId==null) throw new Unauthorized("Couldn't create user");

	knex.transaction(async trx => {
		await trx<DBSession>("session").where({user: userId.id}).andWhereNot({id: ses.id}).delete();
		await trx<DBSession>("session").where({id: ses.id}).update({user: userId.id});
	});

	return user.username;
}

export async function isLoggedIn() {
	const ses = await session();
	if (ses.user!=null) return (await getUser(ses.user))?.discordUsername ?? null;
	return null;
}

export async function logout() {
	const ses = await session();
	await knex<DBSession>("session").where({id: ses.id}).delete();
}