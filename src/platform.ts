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
	/** Attachments carried by the message (documents, files, images). The agent
	 * can download their bytes via the platform's getAttachment() and read their
	 * text through the open_attachment tool. */
	attachments?: ChatAttachment[];
	/** True only in a 1:1 DM between the agent and a single user — the only
	 * place identity linking (/link) is allowed. */
	direct: boolean;
}

/** A file attached to a message. The download key is platform-specific; the
 * platform's getAttachment() knows how to turn it into bytes. */
export interface ChatAttachment {
	/** Platform-specific id/url used by getAttachment() to fetch the bytes. */
	id: string;
	/** Original filename, when the platform provides one. */
	name?: string;
	/** MIME type, when the platform provides one. */
	mime?: string;
	/** Approximate size in bytes, when the platform provides one. */
	size?: number;
	/** Direct download URL, when the platform provides one (Discord CDN). */
	url?: string;
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
	/** Fetch an attachment's bytes by its platform-specific id. Platforms that
	 * can receive attachments implement this. */
	getAttachment?(att: ChatAttachment): Promise<Buffer>;
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