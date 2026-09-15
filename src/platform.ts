/**
 * Shared chat-transport types. Every platform (Telegram, Slack, Discord,
 * Matrix) yields ChatMessages from its own long-poll/websocket loop and can
 * send text (and optionally voice) back to a chat.
 */

export interface ChatRef {
	/** Platform id: "telegram" | "slack" | "discord" | "matrix". */
	platform: string;
	/** Platform-specific chat id (stringified; Telegram ids are numeric). */
	chatId: string;
}

/** "telegram:123" — the namespaced key identifying a chat everywhere
 * (session dirs, schedules, identity links, the recall index). */
export function chatKey(ref: ChatRef): string {
	return `${ref.platform}:${ref.chatId}`;
}

export interface ChatMessage {
	ref: ChatRef;
	/** Platform user id of the sender. */
	userId: string;
	/** Display name, when the platform provides one. */
	userName?: string;
	text?: string;
	/** Voice attachment id (Telegram file_id); platforms without voice never set it. */
	voiceFileId?: string;
	/** True only in a 1:1 DM between the agent and a single user — the only
	 * place identity linking (/link) is allowed. */
	direct: boolean;
}

export interface Platform {
	id: string;
	name: string;
	poll(signal: AbortSignal): AsyncGenerator<ChatMessage>;
	/** Send a text message; returns the platform message id when known (used to
	 * delete transient status messages). */
	sendText(ref: ChatRef, text: string): Promise<string | undefined>;
	/** Best-effort typing indicator; some platforms have none. */
	sendTyping(ref: ChatRef): Promise<void>;
	deleteMessage(ref: ChatRef, messageId: string): Promise<void>;
	/** Voice replies; platforms without voice support omit this. */
	sendVoice?(ref: ChatRef, data: Buffer, mime: string): Promise<void>;
	/** Fetch a voice attachment by id (Telegram file_id); voice platforms only. */
	getVoice?(fileId: string): Promise<Buffer>;
}

/** Split long text into sendable chunks (platforms cap message length). */
export function chunkText(text: string, max: number): string[] {
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max));
	return chunks.length ? chunks : [""];
}

/** Simple async FIFO used by websocket transports (Discord, Slack) to hand
 * events to the poll generator across reconnects. */
export class MessageQueue {
	private buffer: ChatMessage[] = [];
	private waiters: ((m: ChatMessage | null) => void)[] = [];
	push(msg: ChatMessage | null): void {
		const w = this.waiters.shift();
		if (w) w(msg);
		else if (msg) this.buffer.push(msg);
	}
	async next(): Promise<ChatMessage | null> {
		if (this.buffer.length) return this.buffer.shift()!;
		return new Promise((resolve) => this.waiters.push(resolve));
	}
}