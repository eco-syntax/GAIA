import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// PI_GATEWAY_STATE lets tests point the registry/state at a temp dir instead of
// the live ~/.pi-gateway — never run a store test without it.
const STATE_DIR = process.env.PI_GATEWAY_STATE ?? join(homedir(), ".pi-gateway");

export interface Schedule {
	name: string;
	/** Interval like "30m", "2h", "1d" — or a daily time "09:30". */
	every?: string;
	at?: string;
	/** Telegram chat id that receives the result. */
	chatId: number;
	prompt: string;
	/** Inject the result into the chat's session log so follow-up questions are grounded (default true). */
	inject?: boolean;
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
	/** whisper.cpp ggml model for voice-note transcription; omit to ignore voice messages. */
	whisperModel?: string;
	/** Bash allowlist patterns ("git *", "npm test"); every shell segment must match one. Empty = bash fully denied. */
	allowedCommands?: string[];
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
		whisperModel: raw.whisperModel,
		allowedCommands: raw.allowedCommands ?? [],
		schedules: raw.schedules ?? [],
	};
}

/** Set the default model: update the in-memory config AND persist it. */
export function setModel(config: Config, model: Config["model"]): void {
	config.model = model;
	const path = join(STATE_DIR, "config.json");
	const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
	raw.model = model;
	writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
}

export const stateDir = STATE_DIR;

/** Add a bash allowlist pattern: update the in-memory config AND persist it. */
export function addAllowedCommand(config: Config, pattern: string): void {
	config.allowedCommands = [...(config.allowedCommands ?? [])];
	if (!config.allowedCommands.includes(pattern)) config.allowedCommands.push(pattern);
	const path = join(STATE_DIR, "config.json");
	const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
	raw.allowedCommands = config.allowedCommands;
	writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
}
