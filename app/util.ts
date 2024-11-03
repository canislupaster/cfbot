export type HintType = "yesNo"|"oneWord"|"small"|"medium"|"big"|"complexity";

export type APIErrorType = "failed"|"problemNotFound"|"editorialNotFound"|"refusal"|"other"|"overusage";
export class APIError extends Error {
	type: APIErrorType;

	constructor(ty: APIErrorType, msg: string) {
		super(msg);
		this.type=ty;
	}
}

export class Unauthorized extends Error {
	constructor(msg: string) {super(msg);}
}

export const ROOT_URL = process.env["ROOT_URL"]!;
export type AuthFailure = {type: "login", redirect: string}|{type: "notInDiscord", redirect: string};

export type HintResult = {
	result: string,
	usage: {tokens: number, cents: number},
	code: {source: string, language: string}|null
};

export type LoginInfo = {
	discordUsername: string,
	cents: number, maxCent: number,
	resetTime: number|null,
	model: string
};

//to get around nextjs exception sanitization, we only allow apierror and unauthorized through by wrapping everything up...
//i never want to see this again!

type APIResult<R> = {status: "ok", result: R}
	| {status: "apiError", type: APIErrorType, msg: string}
	| {status: "unauthorized", msg: string};

export function apiRes<T extends any[],R>(f: (...args: T)=>Promise<R>): (...args: T)=>Promise<APIResult<R>> {
	return async (...args) => {
		try {
			return {status: "ok", result: await f(...args)};
		} catch (e) {
			console.error(e);
      if (e instanceof APIError) return {status:"apiError", type: e.type, msg: e.message};
      else if (e instanceof Unauthorized) return {status:"unauthorized", msg: e.message};
      else return {status: "apiError", type: "other", msg: "An unknown error occurred"};
		}
	}
}

export function resApi<T extends any[],R>(f: (...args: T)=>Promise<APIResult<R>>): (...args: T)=>Promise<R> {
	return async (...args) => {
		const res = await f(...args);
		if (res.status=="apiError") throw new APIError(res.type, res.msg);
		else if (res.status=="unauthorized") throw new Unauthorized(res.msg);
		return res.result;
	};
}
