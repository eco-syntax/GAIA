/**
 * Slack transport: Socket Mode websocket (receive) + Web API (send), no SDK.
 * Requires a socket-mode app-level token (xapp-…) to open the connection and
 * a bot token (xoxb-…) to post. Events are acknowledged within Slack's 3s
 * window. IM channels ("D…"/channel_type "im") count as 1:1 chats for /link.
 */

import { fetchJson, sleep } from "./net.js";
import { chunkText, MessageQueue, type ChatMessage, type ChatRef, type Platform } from "./platform.js";

const API = "https://slack.com/api";

interface SlackMessageEvent {
	type?: string;
	subtype?: string;
	user?: string;
	bot_id?: string;
	channel?: string;
	channel_type?: string;
	text?: string;
	ts?: string;
}

interface SlackSocketEvent {
	type?: string;
	envelope_id?: string;
	payload?: { type?: string; event?: SlackMessageEvent };
}

export function createSlackPlatform(botToken: string, appToken: string, allowedChatIds: string[]): Platform {
	const allowed = new Set(allowedChatIds);

	function handleMessage(evt: SlackMessageEvent, deliver: (m: ChatMessage) => void): void {
		// subtype undefined = regular user message; skip edits, deletions, bots, etc.
		if (evt.subtype && evt.subtype !== "bot_message") return;
		if (!evt.user) return; // bot messages carry bot_id, not user
		const channel = evt.channel ?? "";
		if (!channel || !allowed.has(channel)) return;
		const text = evt.text?.trim();
		if (!text) return;
		const direct = evt.channel_type === "im" || (!evt.channel_type && channel.startsWith("D"));
		deliver({
			ref: { platform: "slack", chatId: channel },
			userId: evt.user,
			text,
			direct,
		});
	}

	return {
		id: "slack",
		name: "Slack",
		async *poll(signal): AsyncGenerator<ChatMessage> {
			const queue = new MessageQueue();
			signal.addEventListener("abort", () => queue.push(null), { once: true });
			void (async () => {
				while (!signal.aborted) {
					let ws: WebSocket | undefined;
					try {
						const res = await fetchJson<{ ok: boolean; url?: string; error?: string }>(
							`${API}/apps.connections.open`,
							{ method: "POST", headers: { authorization: `Bearer ${appToken}` } },
							"slack apps.connections.open",
							signal,
						);
						if (!res.ok || !res.url) {
							throw new Error(`slack apps.connections.open: ${res.error ?? "no websocket url"}`);
						}
						ws = new WebSocket(res.url);
						ws.onmessage = (ev) => {
							const data = JSON.parse(String(ev.data)) as SlackSocketEvent;
							if (data.type === "events_api" && data.envelope_id) {
								// Ack within Slack's 3s window or the event is redelivered.
								try { ws?.send(JSON.stringify({ envelope_id: data.envelope_id, payload: {} })); } catch { /* closed */ }
								const evt = data.payload?.event;
								if (data.payload?.type === "event_callback" && evt?.type === "message") {
									handleMessage(evt, (m) => queue.push(m));
								}
							} else if (data.type === "disconnect") {
								try { ws?.close(); } catch { /* already closed */ }
							}
						};
						await new Promise<void>((resolve, reject) => {
							ws!.onopen = () => resolve();
							ws!.onerror = () => reject(new Error("slack socket error"));
						});
						// Connected: wait until the socket drops, then reconnect.
						await new Promise<void>((resolve) => { ws!.onclose = () => resolve(); });
					} catch (err) {
						if (signal.aborted) return;
						console.error("slack socket error:", err);
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
			let lastTs: string | undefined;
			for (const chunk of chunkText(text, 3800)) {
				const res = await fetchJson<{ ok: boolean; ts?: string; error?: string }>(
					`${API}/chat.postMessage`,
					{
						method: "POST",
						headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
						body: JSON.stringify({ channel: ref.chatId, text: chunk }),
					},
					"slack chat.postMessage",
				);
				if (!res.ok) throw new Error(`slack chat.postMessage: ${res.error ?? "failed"}`);
				lastTs = res.ts;
			}
			return lastTs;
		},
		async sendTyping(_ref: ChatRef): Promise<void> {
			// Slack's API has no bot typing indicator; nothing to do.
		},
		async deleteMessage(ref: ChatRef, messageId: string): Promise<void> {
			try {
				await fetchJson<{ ok: boolean }>(
					`${API}/chat.delete`,
					{
						method: "POST",
						headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
						body: JSON.stringify({ channel: ref.chatId, ts: messageId }),
					},
					"slack chat.delete",
				);
			} catch {
				// cosmetic; ignore failures
			}
		},
	};
}
