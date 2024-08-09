export type HintType = "yesNo"|"oneWord"|"small"|"medium"|"big";

export type APIErrorType = "failed"|"problemNotFound"|"editorialNotFound"|"refusal";
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
export type AuthResult = {type: "success"}|{type: "login", redirect: string}|{type: "notInDiscord", redirect: string};