import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatRef } from "./platform.js";

// PI_GATEWAY_STATE lets tests point the registry/state at a temp dir instead of
// the live ~/.pi-gateway — never run a store test without it.
const STATE_DIR = process.env.PI_GATEWAY_STATE ?? join(homedir(), ".pi-gateway");

export interface Schedule {
	name: string;
	/** Interval like "30m", "2h", "1d" — or a daily time "09:30". */
	every?: string;
	at?: string;
	/** Platform the chat lives on; default "telegram" (legacy configs). */
	platform?: string;
	/** Chat id on that platform (a number for legacy telegram configs). */
	chatId: number | string;
	prompt: string;
	/** Inject the result into the chat's session log so follow-up questions are grounded (default true). */
	inject?: boolean;
}

/** Resolve a schedule's destination chat. */
export function scheduleChatRef(s: Schedule): ChatRef {
	return { platform: s.platform ?? "telegram", chatId: String(s.chatId) };
}

export interface Config {
	telegramBotToken?: string;
	/** Telegram chats allowed to talk to the agent. Must be non-empty when telegram is configured. */
	allowedChatIds?: string[];
	/** Slack bot token (xoxb-…) + socket-mode app-level token (xapp-…). */
	slackBotToken?: string;
	slackAppToken?: string;
	allowedSlackChatIds?: string[];
	/** Discord bot token. */
	discordBotToken?: string;
	allowedDiscordChatIds?: string[];
	/** Matrix client-server API: homeserver base URL + bot account. */
	matrixHomeserver?: string;
	matrixUserId?: string;
	matrixAccessToken?: string;
	allowedMatrixRoomIds?: string[];
	/** Model override for all sessions; omit to use pi's default resolution. */
	model?: { provider: string; id: string; /** Overrides the catalog guess — set to your server's real context (e.g. 32768). */
		contextWindow?: number;
		maxTokens?: number; };
	/** Piper TTS voice; omit to disable voice replies (Telegram only). */
	piperVoice?: string;
	/** whisper.cpp ggml model for voice-note transcription; omit to ignore voice messages (Telegram only). */
	whisperModel?: string;
	/** Bash allowlist patterns ("git *", "npm test"); every shell segment must match one. Empty = bash fully denied. */
	allowedCommands?: string[];
	schedules: Schedule[];
}

interface ConfiguredPlatform {
	id: string;
	allowlist: unknown;
	allowlistKey: string;
}

/** Which platforms the config turns on, validating partial credentials. */
function configuredPlatforms(raw: Partial<Config>): ConfiguredPlatform[] {
	const out: ConfiguredPlatform[] = [];
	if (raw.telegramBotToken) {
		out.push({ id: "telegram", allowlist: raw.allowedChatIds, allowlistKey: "allowedChatIds" });
	}
	if (raw.slackBotToken || raw.slackAppToken) {
		if (!raw.slackBotToken || !raw.slackAppToken) {
			throw new Error("slack requires both slackBotToken (xoxb-…) and slackAppToken (xapp-…) in config.json");
		}
		out.push({ id: "slack", allowlist: raw.allowedSlackChatIds, allowlistKey: "allowedSlackChatIds" });
	}
	if (raw.discordBotToken) {
		out.push({ id: "discord", allowlist: raw.allowedDiscordChatIds, allowlistKey: "allowedDiscordChatIds" });
	}
	if (raw.matrixHomeserver || raw.matrixAccessToken || raw.matrixUserId) {
		if (!raw.matrixHomeserver || !raw.matrixAccessToken || !raw.matrixUserId) {
			throw new Error("matrix requires matrixHomeserver, matrixUserId and matrixAccessToken in config.json");
		}
		out.push({ id: "matrix", allowlist: raw.allowedMatrixRoomIds, allowlistKey: "allowedMatrixRoomIds" });
	}
	return out;
}

export function loadConfig(): Config {
	const path = join(STATE_DIR, "config.json");
	let raw: Partial<Config>;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(
				`No ${path} — create one with at least one chat platform token (telegramBotToken, slackBotToken+slackAppToken, discordBotToken, or matrixHomeserver+matrixUserId+matrixAccessToken) and a non-empty allow-list.`,
			);
		}
		throw err;
	}
	const platforms = configuredPlatforms(raw);
	if (platforms.length === 0) {
		throw new Error(
			`No chat platforms configured — set telegramBotToken, slackBotToken+slackAppToken, discordBotToken, or matrixHomeserver+matrixUserId+matrixAccessToken in ${path}.`,
		);
	}
	// Fail closed: an empty allow-list must never mean "allow everyone".
	// Every allowed chat's session exposes shell/filesystem tools, so an empty
	// list would be unauthenticated remote code execution for anyone who finds
	// the bot. (Same rule per platform as the original allowedChatIds check.)
	for (const p of platforms) {
		const ids = Array.isArray(p.allowlist) ? p.allowlist : [];
		if (ids.length === 0) {
			throw new Error(
				`Set a non-empty ${p.allowlistKey} in ${path} — refusing to start ${p.id} without an allow-list.`,
			);
		}
	}
	mkdirSync(STATE_DIR, { recursive: true });
	return {
		telegramBotToken: raw.telegramBotToken,
		allowedChatIds: (raw.allowedChatIds ?? []).map(String),
		slackBotToken: raw.slackBotToken,
		slackAppToken: raw.slackAppToken,
		allowedSlackChatIds: raw.allowedSlackChatIds ?? [],
		discordBotToken: raw.discordBotToken,
		allowedDiscordChatIds: raw.allowedDiscordChatIds ?? [],
		matrixHomeserver: raw.matrixHomeserver,
		matrixUserId: raw.matrixUserId,
		matrixAccessToken: raw.matrixAccessToken,
		allowedMatrixRoomIds: raw.allowedMatrixRoomIds ?? [],
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
export const researchDir = join(STATE_DIR, "research");

/** Add a bash allowlist pattern: update the in-memory config AND persist it. */
export function addAllowedCommand(config: Config, pattern: string): void {
	config.allowedCommands = [...(config.allowedCommands ?? [])];
	if (!config.allowedCommands.includes(pattern)) config.allowedCommands.push(pattern);
	const path = join(STATE_DIR, "config.json");
	const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
	raw.allowedCommands = config.allowedCommands;
	writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
}