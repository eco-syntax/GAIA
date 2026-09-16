/**
 * Telegram transport: long-poll receive + send text/voice. No SDK dependency;
 * plain Bot API over fetch.
 */

import { fetch, FormData as undiciFormData } from "undici";
import { toTelegramHtml } from "./format.js";
import { retry, sleep } from "./net.js";
import { chunkText, type ChatAttachment, type ChatMessage, type ChatRef, type Platform } from "./platform.js";

const API = "https://api.telegram.org/bot";

interface TgMessage {
	message_id: number;
	from?: { id: number; first_name?: string; username?: string };
	chat: { id: number; type?: string };
	text?: string;
	voice?: { file_id: string };
	document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
	photo?: { file_id: string; file_size?: number }[];
	video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
	date?: number;
}

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

// errorCode (and the retry/sleep helpers) live in net.js, shared by every
// chat-platform transport; re-export here so index.ts can keep importing it
// from telegram.js alongside deepestCause.
export { errorCode } from "./net.js";

interface TgUpdate {
	update_id: number;
	message?: TgMessage;
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

/** Fetch a Telegram file's bytes by file_id (shared by voice + attachments). */
async function getFileBytes(token: string, fileId: string): Promise<Buffer> {
	const file = (await tg(token, "getFile", { file_id: fileId })) as { file_path?: string };
	if (!file.file_path) throw new Error("telegram getFile: no file_path");
	return retry("telegram file download", async () => {
		const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
		if (!res.ok) throw new Error(`telegram file download: ${res.status}`);
		return Buffer.from(await res.arrayBuffer());
	});
}

/** Pull attachment descriptors out of a Telegram message: documents (files, PDFs),
 * photos (largest size available), videos. Voice is handled separately, not here. */
function collectAttachments(msg: TgMessage): ChatAttachment[] {
	const out: ChatAttachment[] = [];
	if (msg.document?.file_id) {
		out.push({
			id: msg.document.file_id,
			name: msg.document.file_name ?? "document",
			mime: msg.document.mime_type,
			size: msg.document.file_size,
		});
	}
	if (msg.photo?.length) {
		// photo is an array of sizes; the last entry is the largest.
		const best = msg.photo[msg.photo.length - 1];
		if (best?.file_id) {
			out.push({ id: best.file_id, name: "photo.jpg", mime: "image/jpeg", size: best.file_size });
		}
	}
	if (msg.video?.file_id) {
		out.push({
			id: msg.video.file_id,
			name: msg.video.file_name ?? "video.mp4",
			mime: msg.video.mime_type,
			size: msg.video.file_size,
		});
	}
	return out;
}

/** Telegram platform. Voice is Telegram-only: incoming voice notes are fetched
 * by file_id and replies can be sent as OGG/Opus voice notes. */
export function createTelegramPlatform(token: string, allowedChatIds: string[]): Platform {
	const allowed = new Set(allowedChatIds.map(String));
	return {
		id: "telegram",
		name: "Telegram",
		async *poll(signal): AsyncGenerator<ChatMessage> {
			// Fail closed: an empty allow-list must never be treated as "allow all".
			if (allowed.size === 0) {
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
						// Confirm every update exactly once, even ones we skip — otherwise a
						// lone photo/sticker re-pollutes every subsequent getUpdates response.
						offset = Math.max(offset, u.update_id + 1);
						const msg = u.message;
						if (!msg?.from) continue;
						// A message with only an attachment (e.g. a PDF) has no text; keep
						// it if any attachment type is present so it isn't silently dropped.
						const attachments = collectAttachments(msg);
						if (!msg.text && !msg.voice && attachments.length === 0) continue;
						const chatId = String(msg.chat.id);
						if (!allowed.has(chatId)) continue;
						const date = msg.date;
						if (date !== undefined && date < startedAt) continue;
						// Fingerprint on whichever content the message carries. For a file-only
						// message use the attachment ids so a redelivered copy still dedups.
						const fpContent = msg.text
							?? (msg.voice ? `voice:${msg.voice.file_id.slice(0, 20)}` : `file:${attachments.map((a) => a.id).join(",").slice(0, 40)}`);
						const fp = `${chatId}:${date}:${fpContent}`;
						if (!remember(fp)) continue;
						yield {
							ref: { platform: "telegram", chatId },
							userId: String(msg.from.id),
							userName: msg.from.first_name ?? msg.from.username,
							text: msg.text,
							voiceFileId: msg.voice?.file_id,
							attachments,
							direct: msg.chat.type === "private",
						};
					}
				} catch (err) {
					if (signal.aborted) return;
					console.error("telegram poll error:", err);
					await sleep(3000, signal);
				}
			}
		},
		async sendText(ref: ChatRef, text: string): Promise<string | undefined> {
			const chatId = Number(ref.chatId);
			// Telegram caps messages at 4096 chars. Chunk the RAW markdown first,
			// then convert each chunk: splitting HTML can cut mid-tag and 400s it.
			let lastId: string | undefined;
			for (const chunk of chunkText(text, 3800)) {
				const html = toTelegramHtml(chunk);
				const result = (await tg(token, "sendMessage", {
					chat_id: chatId,
					text: html,
					parse_mode: "HTML",
					link_preview_options: { is_disabled: true },
				})) as { message_id: number };
				lastId = String(result.message_id);
			}
			return lastId;
		},
		async sendVoice(ref: ChatRef, wav: Buffer): Promise<void> {
			const chatId = Number(ref.chatId);
			// Rebuild the FormData inside the retry: a consumed body cannot be replayed.
			await retry("telegram sendVoice", async () => {
				const form = new undiciFormData();
				form.set("chat_id", String(chatId));
				form.set("voice", new Blob([new Uint8Array(wav)], { type: "audio/ogg" }), "reply.ogg");
				const res = await fetch(`${API}${token}/sendVoice`, { method: "POST", body: form });
				const json = (await res.json()) as { ok: boolean; description?: string };
				if (!json.ok) throw new Error(`telegram sendVoice: ${json.description}`);
			});
		},
		async sendTyping(ref: ChatRef): Promise<void> {
			try {
				await tg(token, "sendChatAction", { chat_id: Number(ref.chatId), action: "typing" });
			} catch {
				// cosmetic; ignore failures
			}
		},
		async deleteMessage(ref: ChatRef, messageId: string): Promise<void> {
			try {
				await tg(token, "deleteMessage", { chat_id: Number(ref.chatId), message_id: Number(messageId) });
			} catch {
				// cosmetic; ignore failures
			}
		},
		async getVoice(fileId: string): Promise<Buffer> {
			return getFileBytes(token, fileId);
		},
		async getAttachment(att) {
			return getFileBytes(token, att.id);
		},
	};
}