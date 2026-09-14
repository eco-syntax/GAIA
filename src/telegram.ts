/**
 * Telegram transport: long-poll receive + send text/voice. No SDK dependency;
 * plain Bot API over fetch.
 */

import { fetch, FormData as undiciFormData } from "undici";
import { toTelegramHtml } from "./format.js";

const API = "https://api.telegram.org/bot";

// Transient network failures are routine here (ECONNRESET on a reused keep-alive
// socket, laptop suspend/wifi churn, DNS blips). A single blip must not become a
// user-visible "Error: TypeError: fetch failed", so every Bot API call is retried.
const RETRYABLE_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"EPIPE",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"ENOTFOUND",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
	"UND_ERR_CLOSED",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);

/** Deepest error in undici's nested err.cause chain — the outer
 * "TypeError: fetch failed" says nothing, the real reason sits in the cause. */
export function deepestCause(err: unknown): unknown {
	let e = err;
	for (let i = 0; e && i < 6; i++) {
		const next = (e as { cause?: unknown }).cause;
		if (next === undefined) return e;
		e = next;
	}
	return e;
}

/** Walk the error/cause chain for a transport error code (undici nests causes). */
export function errorCode(err: unknown): string | undefined {
	let e = err;
	for (let i = 0; e && i < 6; i++) {
		const code = (e as { code?: unknown }).code;
		if (typeof code === "string") return code;
		e = (e as { cause?: unknown }).cause;
	}
	return undefined;
}

function isTransient(err: unknown): boolean {
	const code = errorCode(err);
	if (code && RETRYABLE_CODES.has(code)) return true;
	const status = (err as { errorCode?: number; status?: number } | undefined)?.errorCode
		?? (err as { status?: number } | undefined)?.status;
	if (status === 429 || (status !== undefined && status >= 500)) return true;
	return err instanceof TypeError && /fetch failed|terminated|other side closed|socket hang up/i.test(err.message);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
	});
}

/** Retry a network operation on transient failures with backoff. Honors an
 * AbortSignal (shutdown) and Telegram's `retry_after` on 429. */
async function retry<T>(label: string, fn: () => Promise<T>, signal?: AbortSignal, attempts = 4): Promise<T> {
	let last: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			last = err;
			if (signal?.aborted || !isTransient(err) || attempt === attempts - 1) throw err;
			const retryAfter = (err as { retryAfter?: number }).retryAfter;
			const delay = (retryAfter ? retryAfter * 1000 : 400 * 2 ** attempt) + Math.random() * 200;
			console.warn(`${label}: transient network error (${errorCode(err) ?? "unknown"}), retrying in ${Math.round(delay)}ms`);
			await sleep(delay, signal);
		}
	}
	throw last;
}

interface TgUpdate {
	message?: {
		chat: { id: number };
		text?: string;
		voice?: { file_id: string };
		chat_type?: string;
	};
	callback_query?: {
		id: string;
		from: { id: number };
		message?: { chat: { id: number }; message_id: number };
		data?: string;
	};
}

/** One polled update as seen by the gateway: a message or an inline-button press. */
export interface PolledUpdate {
	chatId: number;
	text?: string;
	voiceFileId?: string;
	callback?: { id: string; data: string; messageId?: number };
}

async function tg(token: string, method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
	return retry(`telegram ${method}`, async () => {
		const res = await fetch(`${API}${token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		const json = (await res.json()) as {
			ok: boolean;
			result?: unknown;
			description?: string;
			error_code?: number;
			parameters?: { retry_after?: number };
		};
		if (!json.ok) {
			const err = new Error(`telegram ${method}: ${json.description}`) as Error & {
				errorCode?: number;
				retryAfter?: number;
			};
			err.errorCode = json.error_code;
			err.retryAfter = json.parameters?.retry_after;
			throw err;
		}
		return json.result;
	}, signal);
}

export interface InlineButton {
	text: string;
	callback_data?: string;
	url?: string;
}

/** Telegram inline-keyboard reply markup. */
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

export async function sendMessage(
	token: string,
	chatId: number,
	text: string,
	replyMarkup?: InlineKeyboard,
): Promise<number> {
	// Telegram caps messages at 4096 chars. Chunk the RAW markdown first, then
	// convert each chunk: splitting HTML can cut mid-tag and Telegram 400s it.
	let lastId = 0;
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += 3800) chunks.push(text.slice(i, i + 3800));
	for (let i = 0; i < chunks.length; i++) {
		const html = toTelegramHtml(chunks[i]!);
		const result = (await tg(token, "sendMessage", {
			chat_id: chatId,
			text: html,
			parse_mode: "HTML",
			link_preview_options: { is_disabled: true },
			// Attach the keyboard to the last chunk, where the options live.
			...(replyMarkup && i === chunks.length - 1 ? { reply_markup: replyMarkup } : {}),
		})) as { message_id: number };
		lastId = result.message_id;
	}
	return lastId;
}

/** Replace an inline-keyboard message's text/buttons (menu navigation). Pass
 * `{ inline_keyboard: [] }` as replyMarkup to strip the buttons. */
export async function editMessageText(
	token: string,
	chatId: number,
	messageId: number,
	text: string,
	replyMarkup?: InlineKeyboard,
): Promise<void> {
	await tg(token, "editMessageText", {
		chat_id: chatId,
		message_id: messageId,
		text: toTelegramHtml(text),
		parse_mode: "HTML",
		...(replyMarkup ? { reply_markup: replyMarkup } : {}),
	});
}

/** Acknowledge an inline-button press (clears the button's spinner). Optional
 * text shows as a brief toast; Telegram truncates it to 200 chars. */
export async function answerCallbackQuery(
	token: string,
	callbackQueryId: string,
	text?: string,
): Promise<void> {
	await tg(token, "answerCallbackQuery", {
		callback_query_id: callbackQueryId,
		...(text ? { text } : {}),
	});
}

export async function sendVoice(token: string, chatId: number, wav: Buffer): Promise<void> {
	// Rebuild the FormData inside the retry: a consumed body cannot be replayed.
	await retry("telegram sendVoice", async () => {
		const form = new undiciFormData();
		form.set("chat_id", String(chatId));
		form.set("voice", new Blob([new Uint8Array(wav)], { type: "audio/ogg" }), "reply.ogg");
		const res = await fetch(`${API}${token}/sendVoice`, { method: "POST", body: form });
		const json = (await res.json()) as { ok: boolean; description?: string };
		if (!json.ok) throw new Error(`telegram sendVoice: ${json.description}`);
	});
}

/** Register the bot's slash-command menu (Telegram's popup list). Cosmetic; ignore failures. */
export async function setMyCommands(
	token: string,
	commands: { command: string; description: string }[],
): Promise<void> {
	try {
		await tg(token, "setMyCommands", { commands });
	} catch (err) {
		console.warn("setMyCommands failed:", err);
	}
}

/** Show the typing indicator; Telegram expires it after ~5s, so call periodically. */
export async function sendTyping(token: string, chatId: number): Promise<void> {
	try {
		await tg(token, "sendChatAction", { chat_id: chatId, action: "typing" });
	} catch {
		// cosmetic; ignore failures
	}
}

export async function deleteMessage(token: string, chatId: number, messageId: number): Promise<void> {
	try {
		await tg(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
	} catch {
		// cosmetic; ignore failures
	}
}

/** Download a voice message's audio (OGG/Opus) by file_id. */
export async function getVoice(token: string, fileId: string): Promise<Buffer> {
	const file = (await tg(token, "getFile", { file_id: fileId })) as { file_path?: string };
	if (!file.file_path) throw new Error("telegram getFile: no file_path");
	return retry("telegram file download", async () => {
		const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
		if (!res.ok) throw new Error(`telegram file download: ${res.status}`);
		return Buffer.from(await res.arrayBuffer());
	});
}

/** Long-poll updates. Yields messages and inline-button presses. */
export async function* pollMessages(
	token: string,
	allowedChatIds: number[],
	signal: AbortSignal,
): AsyncGenerator<PolledUpdate> {
	// Fail closed: an empty allow-list must never be treated as "allow all".
	if (allowedChatIds.length === 0) {
		throw new Error("allowedChatIds is empty; refusing to poll Telegram");
	}
	let offset = 0;
	// Ignore updates older than startup: Telegram redelivers unconfirmed
	// updates after a restart, which would re-run old turns after a crash.
	const startedAt = Math.floor(Date.now() / 1000) - 60;
	// Telegram redelivers an update when a long-poll response is lost
	// (flaky connections), and clients double-send messages; without a dedup
	// each copy runs a full turn and sends a duplicate reply. A redelivered
	// update has an identical chatId:date:text fingerprint, so a single
	// fingerprint set suffices — no separate update_id dedup needed.
	const seenMsgs = new Map<string, true>(); // chatId:date:fingerprint → recent
	const remember = (key: string): boolean => {
		if (seenMsgs.has(key)) return false;
		seenMsgs.set(key, true);
		if (seenMsgs.size > 500) seenMsgs.delete(seenMsgs.keys().next().value!);
		return true;
	};
	while (!signal.aborted) {
		try {
			const updates = (await tg(token, "getUpdates", {
				offset,
				timeout: 50,
				allowed_updates: ["message", "callback_query"],
			}, signal)) as TgUpdate[];
			for (const u of updates ?? []) {
				const updateId = (u as { update_id: number }).update_id;
				// Confirm every update exactly once, even ones we skip — otherwise a
				// lone photo/sticker re-pollutes every subsequent getUpdates response.
				offset = Math.max(offset, updateId + 1);
				// Inline-button presses have no date, so the staleness filter below
				// can't apply; the callback id is globally unique, so it dedups
				// redeliveries on its own.
				const cq = u.callback_query;
				if (cq) {
					const chatId = cq.message?.chat.id ?? cq.from.id;
					if (!allowedChatIds.includes(chatId)) continue;
					if (!remember(`cq:${cq.id}`)) continue;
					yield {
						chatId,
						callback: { id: cq.id, data: cq.data ?? "", messageId: cq.message?.message_id },
					};
					continue;
				}
				const msg = u.message;
				if (!msg?.text && !msg?.voice) continue;
				if (!allowedChatIds.includes(msg.chat.id)) continue;
				const date = (msg as { date?: number }).date;
				if (date !== undefined && date < startedAt) continue;
				const fp = `${msg.chat.id}:${date}:${msg.text ?? `voice:${msg.voice!.file_id.slice(0, 20)}`}`;
				if (!remember(fp)) continue;
				yield { chatId: msg.chat.id, text: msg.text, voiceFileId: msg.voice?.file_id };
			}
		} catch (err) {
			if (signal.aborted) return;
			console.error("telegram poll error:", err);
			await new Promise((r) => setTimeout(r, 3000));
		}
	}
}
