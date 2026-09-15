/**
 * Discord transport: gateway websocket (receive) + REST (send), no SDK.
 * Uses Node's built-in WebSocket. Intents: GUILD_MESSAGES + DIRECT_MESSAGES +
 * MESSAGE_CONTENT. Channels are filtered by the allow-list; channel type 1
 * (DM) counts as a 1:1 chat for /link.
 */

import { fetchJson, sleep } from "./net.js";
import { chunkText, MessageQueue, type ChatMessage, type ChatRef, type Platform } from "./platform.js";

const API = "https://discord.com/api/v10";
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15); // GUILD_MESSAGES, DIRECT_MESSAGES, MESSAGE_CONTENT

interface DiscordMessage {
	id: string;
	type: number;
	channel_id: string;
	channel_type?: number;
	author?: { id: string; username?: string; bot?: boolean };
	content?: string;
}

interface GatewayPayload {
	op: number;
	t?: string;
	d?: unknown;
	s?: number;
}

export function createDiscordPlatform(token: string, allowedChannelIds: string[]): Platform {
	const allowed = new Set(allowedChannelIds);
	let botId: string | undefined;

	/** Open a gateway connection and return it once HELLO (op 10) arrives,
	 * wiring heartbeats and dispatching events until the socket closes. */
	function openGateway(url: string, onDispatch: (t: string, d: unknown) => void): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			let seq = 0;
			let heartbeat: NodeJS.Timeout | undefined;
			const cleanup = () => {
				if (heartbeat) {
					clearInterval(heartbeat);
					heartbeat = undefined;
				}
			};
			ws.onopen = () => {
				ws.send(JSON.stringify({
					op: 2,
					d: { token, intents: INTENTS, properties: { os: "linux", browser: "pi-gateway", device: "pi-gateway" } },
				}));
			};
			ws.onmessage = (ev) => {
				const data = JSON.parse(String(ev.data)) as GatewayPayload;
				if (data.op === 10) {
					const interval = (data.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 41_250;
					heartbeat = setInterval(() => {
						try { ws.send(JSON.stringify({ op: 1, d: seq })); } catch { /* socket closed */ }
					}, interval);
					resolve(ws);
				} else if (data.op === 0) {
					if (data.s !== undefined) seq = data.s;
					onDispatch(data.t ?? "", data.d);
				} else if (data.op === 1) {
					// server-requested heartbeat
					try { ws.send(JSON.stringify({ op: 1, d: seq })); } catch { /* socket closed */ }
				} else if (data.op === 7 || data.op === 9) {
					// reconnect requested / invalid session
					cleanup();
					try { ws.close(); } catch { /* already closed */ }
				}
				// op 11 = heartbeat ack; nothing to do
			};
			ws.onclose = () => { cleanup(); reject(new Error("discord gateway closed before ready")); };
			ws.onerror = () => { cleanup(); reject(new Error("discord gateway error")); };
		});
	}

	function handleMessage(d: unknown, deliver: (m: ChatMessage) => void): void {
		const m = d as DiscordMessage;
		if (!m?.author || m.author.bot) return; // own + other bots' messages
		if (m.type !== 0) return; // only default messages (not pins, replies are type 19 → skip)
		if (!allowed.has(m.channel_id)) return;
		const text = m.content?.trim();
		if (!text) return;
		deliver({
			ref: { platform: "discord", chatId: m.channel_id },
			userId: m.author.id,
			userName: m.author.username,
			text,
			direct: m.channel_type === 1, // DM; group DMs (3) are not 1:1
		});
	}

	return {
		id: "discord",
		name: "Discord",
		async *poll(signal): AsyncGenerator<ChatMessage> {
			const queue = new MessageQueue();
			signal.addEventListener("abort", () => queue.push(null), { once: true });
			void (async () => {
				while (!signal.aborted) {
					try {
						const { url } = await fetchJson<{ url: string }>(`${API}/gateway`, {}, "discord gateway", signal);
						const ws = await openGateway(`${url}/?v=10&encoding=json`, (t, d) => {
							if (t === "READY") botId = (d as { user?: { id?: string } }).user?.id;
							else if (t === "MESSAGE_CREATE") handleMessage(d, (m) => queue.push(m));
						});
						await new Promise<void>((resolve) => { ws.onclose = () => resolve(); });
					} catch (err) {
						if (signal.aborted) return;
						console.error("discord gateway error:", err);
					}
					await sleep(3000, signal);
				}
				queue.push(null);
			})();
			while (!signal.aborted) {
				const msg = await queue.next();
				if (!msg) return;
				yield msg;
			}
		},
		async sendText(ref: ChatRef, text: string): Promise<string | undefined> {
			let lastId: string | undefined;
			for (const chunk of chunkText(text, 2000)) {
				const res = await fetchJson<{ id?: string }>(
					`${API}/channels/${encodeURIComponent(ref.chatId)}/messages`,
					{
						method: "POST",
						headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
						body: JSON.stringify({ content: chunk }),
					},
					"discord sendMessage",
				);
				lastId = res.id;
			}
			return lastId;
		},
		async sendTyping(ref: ChatRef): Promise<void> {
			try {
				await fetchJson(
					`${API}/channels/${encodeURIComponent(ref.chatId)}/typing`,
					{ method: "POST", headers: { authorization: `Bot ${token}` } },
					"discord typing",
				);
			} catch {
				// cosmetic; ignore failures
			}
		},
		async deleteMessage(ref: ChatRef, messageId: string): Promise<void> {
			try {
				await fetchJson(
					`${API}/channels/${encodeURIComponent(ref.chatId)}/messages/${encodeURIComponent(messageId)}`,
					{ method: "DELETE", headers: { authorization: `Bot ${token}` } },
					"discord deleteMessage",
				);
			} catch {
				// cosmetic; ignore failures
			}
		},
	};
}