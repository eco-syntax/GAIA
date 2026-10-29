/**
 * Matrix transport: client-server API over plain HTTP (long-poll sync).
 * No SDK dependency. Rooms are filtered by the allow-list; a room with exactly
 * two joined members (the bot + one user) counts as a 1:1 DM for /link.
 */

import { fetchJson, retry, sleep } from "./net.js";
import { readBodyLimited } from "./web.js";
import { chunkText, type ChatAttachment, type ChatMessage, type ChatRef, type Platform } from "./platform.js";

interface MatrixSync {
	next_batch?: string;
	rooms?: {
		join?: Record<string, {
			summary?: { joined_member_count?: number };
			timeline?: { events?: MatrixEvent[] };
		}>;
	};
}

interface MatrixEvent {
	type?: string;
	event_id?: string;
	sender?: string;
	content?: {
		msgtype?: string;
		body?: string;
		url?: string; // mxc:// media URI for m.file/m.image/m.video/m.audio
		info?: { mimetype?: string; size?: number };
	};
}

/** Matrix msgtypes that carry a media attachment (as opposed to plain text). */
function isFileMsgtype(msgtype: string | undefined): boolean {
	return msgtype === "m.file" || msgtype === "m.image" || msgtype === "m.video" || msgtype === "m.audio";
}

export function createMatrixPlatform(
	homeserver: string,
	userId: string,
	accessToken: string,
	allowedRoomIds: string[],
): Platform {
	const allowed = new Set(allowedRoomIds);
	const base = homeserver.replace(/\/+$/, "");
	const headers = { authorization: `Bearer ${accessToken}` };
	/** Startup credential check: the install prompts can't validate the token
	 * against the homeserver, so surface a bad one immediately instead of
	 * letting sync fail in a retry loop the user never sees. */
	const verifyToken = async (): Promise<void> => {
		let whoami: { user_id?: string };
		try {
			whoami = await fetchJson<{ user_id?: string }>(
				`${base}/_matrix/client/v3/account/whoami`,
				{ headers },
				"matrix whoami",
			);
		} catch (err) {
			if (err && typeof err === "object" && "status" in err) {
				const status = (err as { status?: unknown }).status;
				if (status === 401 || status === 403) {
					throw new Error(
						`matrix access token rejected by ${base} (HTTP ${status}) — the token in the config is invalid or expired. ` +
							`Log into a Matrix client as the bot account and copy a fresh token (Element → Settings → Help & About → Access Token).`,
					);
				}
			}
			throw err; // network-level: the poll loop's retry reporting covers it
		}
		if (whoami.user_id !== userId) {
			throw new Error(
				`matrix access token belongs to ${whoami.user_id ?? "an unknown user"}, but the config says the bot is ${userId} — ` +
					`the token was created for a different account than matrixUserId.`,
			);
		}
	};
	return {
		id: "matrix",
		name: "Matrix",
		verify: verifyToken,
		async *poll(signal): AsyncGenerator<ChatMessage> {
			let since: string | undefined;
			// Sync can redeliver events; dedup by event id.
			const seen = new Map<string, true>();
			while (!signal.aborted) {
				try {
					const q = since ? `since=${encodeURIComponent(since)}` : "";
					const res = await fetchJson<MatrixSync>(
						`${base}/_matrix/client/v3/sync?timeout=30000${q ? `&${q}` : ""}`,
						{ headers },
						"matrix sync",
						signal,
					);
					since = res.next_batch;
					for (const [roomId, room] of Object.entries(res.rooms?.join ?? {})) {
						if (!allowed.has(roomId)) continue;
						const direct = room.summary?.joined_member_count === 2;
						for (const ev of room.timeline?.events ?? []) {
							if (ev.type !== "m.room.message" || !ev.event_id || !ev.sender) continue;
							// Ignore the bot's own outbound messages, which are echoed back
							// by /sync; otherwise each reply self-triggers another turn.
							if (ev.sender === userId) continue;
							if (seen.has(ev.event_id)) continue;
							seen.set(ev.event_id, true);
							if (seen.size > 1000) seen.delete(seen.keys().next().value!);
							// Attachments arrive as discrete msgtypes (text/notice are handled below);
							// a file-only message must not be dropped.
							const isFile = isFileMsgtype(ev.content?.msgtype);
							if (ev.content?.msgtype !== "m.text" && ev.content?.msgtype !== "m.notice" && !isFile) continue;
							const text = ev.content?.body?.trim();
							const attachments = isFile && ev.content?.url ? [{
								id: ev.content.url,
								// mxc://server/mediaid → name from body, mime/size from info.
								name: text || "attachment",
								mime: ev.content.info?.mimetype,
								size: ev.content.info?.size,
							} as ChatAttachment] : [];
							if (!text && attachments.length === 0) continue;
							yield {
								ref: { platform: "matrix", chatId: roomId },
								userId: ev.sender,
								text,
								attachments,
								direct,
							};
						}
					}
				} catch (err) {
					if (signal.aborted) return;
					console.error("matrix sync error:", err);
					await sleep(3000, signal);
				}
			}
		},
		async sendText(ref: ChatRef, text: string): Promise<string | undefined> {
			let lastId: string | undefined;
			let txn = 0;
			for (const chunk of chunkText(text, 3800)) {
				const txnId = `pi${Date.now()}${txn++}`;
				const res = await fetchJson<{ event_id?: string }>(
					`${base}/_matrix/client/v3/rooms/${encodeURIComponent(ref.chatId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
					{
						method: "PUT",
						headers,
						body: JSON.stringify({ msgtype: "m.text", body: chunk }),
					},
					"matrix sendMessage",
				);
				lastId = res.event_id;
			}
			return lastId;
		},
		async sendTyping(ref: ChatRef): Promise<void> {
			try {
				await fetchJson(
					`${base}/_matrix/client/v3/rooms/${encodeURIComponent(ref.chatId)}/typing/${encodeURIComponent(userId)}`,
					{ method: "PUT", headers, body: JSON.stringify({ typing: true, timeout: 5000 }) },
					"matrix typing",
				);
			} catch {
				// cosmetic; ignore failures
			}
		},
		async deleteMessage(ref: ChatRef, messageId: string): Promise<void> {
			try {
				await fetchJson(
					`${base}/_matrix/client/v3/rooms/${encodeURIComponent(ref.chatId)}/redact/${encodeURIComponent(messageId)}/${encodeURIComponent(`pi${Date.now()}`)}`,
					{ method: "POST", headers, body: JSON.stringify({}) },
					"matrix redact",
				);
			} catch {
				// cosmetic; ignore failures
			}
		},
		async getAttachment(att) {
			// mxc://server/mediaId → download through the configured homeserver (it
			// relays from the originating server, so we never dial an arbitrary host).
			const mxc = /^mxc:\/\/([^/]+)\/([^/]+)$/.exec(att.id);
			if (!mxc) throw new Error(`matrix attachment: malformed media uri ${att.id}`);
			const [, server, mediaId] = mxc;
			// The regex guarantees both capture groups are present.
			const fileServer = server!;
			const fileId = mediaId!;
			return retry("matrix file download", async () => {
				const res = await fetch(
					`${base}/_matrix/client/v3/media/download/${encodeURIComponent(fileServer)}/${encodeURIComponent(fileId)}`,
					{ headers },
				);
				if (!res.ok) throw new Error(`matrix file download: ${res.status}`);
				// Bounded read: reject oversized Content-Length, cancel mid-stream at the cap.
				const { buf } = await readBodyLimited(res);
				return buf;
			});
		},
	};
}