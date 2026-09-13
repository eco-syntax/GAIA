import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".pi-gateway");

export interface Schedule {
	name: string;
	/** Interval like "30m", "2h", "1d" — or a daily time "09:30". */
	every?: string;
	at?: string;
	/** Telegram chat id that receives the result. */
	chatId: number;
	prompt: string;
}

export interface Config {
	telegramBotToken: string;
	/** Chats allowed to talk to the agent. Must be non-empty: the gateway refuses to start without an allow-list. */
	allowedChatIds: number[];
	/** Model override for all sessions; omit to use pi's default resolution. */
	model?: { provider: string; id: string; /** Overrides the catalog guess — set to your server's real context (e.g. 32768). */
		contextWindow?: number;
		maxTokens?: number; };
	/** Piper TTS voice; omit to disable voice replies. */
	piperVoice?: string;
	schedules: Schedule[];
}

export function loadConfig(): Config {
	const path = join(STATE_DIR, "config.json");
	const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
	if (!raw.telegramBotToken) throw new Error(`Set telegramBotToken in ${path}`);
	// Fail closed: an empty allow-list must never mean "allow everyone".
	// Every allowed chat's session exposes shell/filesystem tools, so an empty
	// list would be unauthenticated remote code execution for anyone who finds
	// the bot.
	if (!raw.allowedChatIds?.length) {
		throw new Error(
			`Set a non-empty allowedChatIds in ${path} — refusing to start without an allow-list.`,
		);
	}
	mkdirSync(STATE_DIR, { recursive: true });
	return {
		telegramBotToken: raw.telegramBotToken,
		allowedChatIds: raw.allowedChatIds ?? [],
		model: raw.model,
		piperVoice: raw.piperVoice,
		schedules: raw.schedules ?? [],
	};
}

export const stateDir = STATE_DIR;
export const researchDir = join(STATE_DIR, "research");
