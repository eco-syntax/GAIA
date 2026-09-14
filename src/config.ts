import { readFileSync, writeFileSync } from "node:fs";
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
	/** Chats allowed to talk to the agent. Empty = allow all (not recommended). */
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

/** Read the config file, let `mutate` apply its change, then write it back with 0600 perms. */
function updateConfigFile(mutate: (raw: Config) => void): void {
	const path = join(STATE_DIR, "config.json");
	const raw = JSON.parse(readFileSync(path, "utf8")) as Config;
	mutate(raw);
	writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
}

export const stateDir = STATE_DIR;
export const researchDir = join(STATE_DIR, "research");

/** Set the default model: update the in-memory config AND persist it. */
export function setModel(config: Config, model: Config["model"]): void {
	config.model = model;
	updateConfigFile((raw) => {
		raw.model = model;
	});
}

/** Add a bash allowlist pattern: update the in-memory config AND persist it. */
export function addAllowedCommand(config: Config, pattern: string): void {
	config.allowedCommands = [...(config.allowedCommands ?? [])];
	if (!config.allowedCommands.includes(pattern)) config.allowedCommands.push(pattern);
	updateConfigFile((raw) => {
		raw.allowedCommands = config.allowedCommands;
	});
}
