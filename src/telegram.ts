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

/** Walk the error/cause chain for a transport error code (undici nests causes). */
function errorCode(err: unknown): string | undefined {
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

export async function sendMessage(token: string, chatId: number, text: string): Promise<number> {
	// Telegram caps messages at 4096 chars. Chunk the RAW markdown first, then
	// convert each chunk: splitting HTML can cut mid-tag and Telegram 400s it.
	let lastId = 0;
	for (let i = 0; i < text.length; i += 3800) {
		const html = toTelegramHtml(text.slice(i, i + 3800));
		const result = (await tg(token, "sendMessage", {
			chat_id: chatId,
			text: html,
			parse_mode: "HTML",
			link_preview_options: { is_disabled: true },
		})) as { message_id: number };
		lastId = result.message_id;
	}
	return lastId;
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

/** Long-poll updates. Yields { chatId, text?, voiceFileId? } per message. */
export async function* pollMessages(
	token: string,
	allowedChatIds: number[],
	signal: AbortSignal,
): AsyncGenerator<{ chatId: number; text?: string; voiceFileId?: string }> {
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
				allowed_updates: ["message"],
			}, signal)) as TgUpdate[];
			for (const u of updates ?? []) {
				const updateId = (u as { update_id: number }).update_id;
				// Confirm every update exactly once, even ones we skip — otherwise a
				// lone photo/sticker re-pollutes every subsequent getUpdates response.
				offset = Math.max(offset, updateId + 1);
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
