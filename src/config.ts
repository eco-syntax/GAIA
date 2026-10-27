import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatRef } from "./platform.js";

// GAIA_STATE lets tests point the registry/state at a temp dir instead of
// the live ~/.gaia — never run a store test without it.
const STATE_DIR = process.env.GAIA_STATE ?? join(homedir(), ".gaia");

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

export interface ModelSpec {
	provider: string;
	id: string;
	/** Overrides the catalog guess — set to your server's real context (e.g. 32768). */
	contextWindow?: number;
	maxTokens?: number;
}

export interface Config {
	telegramBotToken?: string;
	/** Telegram chats allowed to talk to the agent. Must be non-empty when telegram is configured. */
	allowedChatIds?: string[];
	/** Telegram sender ids allowed to act in allow-listed GROUP chats (issue #60:
	 * chat-id authorization alone admits every group member). Private chats are
	 * unaffected. Fail closed: groups are ignored when this is unset/empty. */
	allowedTelegramUserIds?: string[];
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
	model?: ModelSpec;
	/** Model for plan-mode sessions (cheaper model for read-only planning).
	 * Omit to use `model` for planning too. */
	planModel?: ModelSpec;
	/** Model for act/delegate implementation sessions (stronger model for
	 * writing code). Omit to use `model` for implementation too. */
	actModel?: ModelSpec;
	/** Piper TTS voice; omit to disable voice replies (Telegram only). */
	piperVoice?: string;
	/** whisper.cpp ggml model for voice-note transcription; omit to ignore voice messages (Telegram only). */
	whisperModel?: string;
	/** Bash allowlist patterns ("git *", "npm test"); every shell segment must match one. Empty = bash fully denied. */
	allowedCommands?: string[];
	/** Workspace directory the agent can read and write — the sandbox binds it
	 * in and everything else on the host stays invisible. Default ~/gaia-workspace. */
	workspace?: string;
	/** OS sandbox: "auto" (default) picks the strongest available (bwrap; docker
	 * containers set GAIA_SANDBOX=docker themselves), "off" runs bare — only
	 * honored together with --unsafe at startup. */
	sandbox?: "auto" | "bwrap" | "docker" | "off";
}

/** Environment overrides for container installs: tokens and allow-lists come
 * from an env file outside the container, never from a file the agent could
 * read. Env wins over config.json for every field it sets. */
const ENV_OVERRIDES: Record<string, (raw: Partial<Config>, v: string) => void> = {
	GAIA_TELEGRAM_BOT_TOKEN: (raw, v) => (raw.telegramBotToken = v),
	GAIA_ALLOWED_CHAT_IDS: (raw, v) => (raw.allowedChatIds = v.split(",").map((s) => s.trim()).filter(Boolean)),
	GAIA_ALLOWED_TELEGRAM_USER_IDS: (raw, v) => (raw.allowedTelegramUserIds = v.split(",").map((s) => s.trim()).filter(Boolean)),
	GAIA_SLACK_BOT_TOKEN: (raw, v) => (raw.slackBotToken = v),
	GAIA_SLACK_APP_TOKEN: (raw, v) => (raw.slackAppToken = v),
	GAIA_ALLOWED_SLACK_CHAT_IDS: (raw, v) => (raw.allowedSlackChatIds = v.split(",").map((s) => s.trim()).filter(Boolean)),
	GAIA_DISCORD_BOT_TOKEN: (raw, v) => (raw.discordBotToken = v),
	GAIA_ALLOWED_DISCORD_CHAT_IDS: (raw, v) => (raw.allowedDiscordChatIds = v.split(",").map((s) => s.trim()).filter(Boolean)),
	GAIA_MATRIX_HOMESERVER: (raw, v) => (raw.matrixHomeserver = v),
	GAIA_MATRIX_USER_ID: (raw, v) => (raw.matrixUserId = v),
	GAIA_MATRIX_ACCESS_TOKEN: (raw, v) => (raw.matrixAccessToken = v),
	GAIA_ALLOWED_MATRIX_ROOM_IDS: (raw, v) => (raw.allowedMatrixRoomIds = v.split(",").map((s) => s.trim()).filter(Boolean)),
	GAIA_MODEL: (raw, v) => (raw.model = parseModelSpec(v, raw.model)),
	GAIA_PLAN_MODEL: (raw, v) => (raw.planModel = parseModelSpec(v, raw.planModel)),
	GAIA_ACT_MODEL: (raw, v) => (raw.actModel = parseModelSpec(v, raw.actModel)),
	GAIA_WORKSPACE: (raw, v) => (raw.workspace = v),
	GAIA_SANDBOX: (raw, v) => (raw.sandbox = v as Config["sandbox"]),
	GAIA_PIPER_VOICE: (raw, v) => (raw.piperVoice = v),
	GAIA_WHISPER_MODEL: (raw, v) => (raw.whisperModel = v),
};

/** "provider/id" — a bare id is ambiguous once catalogs mix providers. */
function parseModelSpec(v: string, prev: ModelSpec | undefined): ModelSpec {
	const slash = v.indexOf("/");
	if (slash <= 0 || slash === v.length - 1) {
		throw new Error(`GAIA model env var must be "provider/id" (e.g. llama-cpp/qwen3-8b), got "${v}"`);
	}
	const spec: ModelSpec = { provider: v.slice(0, slash), id: v.slice(slash + 1) };
	return { ...(prev ?? {}), ...spec };
}

function applyEnvOverrides(raw: Partial<Config>): void {
	for (const [key, apply] of Object.entries(ENV_OVERRIDES)) {
		const value = process.env[key];
		if (value !== undefined && value !== "") apply(raw, value);
	}
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
			// Container installs have no config.json: everything arrives via env
			// (env_file in docker-compose). Only error if env provides nothing.
			raw = {};
			applyEnvOverrides(raw);
			if (Object.keys(raw).length === 0) {
				throw new Error(
					`No ${path} and no GAIA_* environment variables — create one with at least one chat platform token (telegramBotToken, slackBotToken+slackAppToken, discordBotToken, or matrixHomeserver+matrixUserId+matrixAccessToken) and a non-empty allow-list, or set GAIA_TELEGRAM_BOT_TOKEN / GAIA_ALLOWED_CHAT_IDS in the environment.`,
				);
			}
		} else {
			throw err;
		}
	}
	applyEnvOverrides(raw);
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
		allowedTelegramUserIds: raw.allowedTelegramUserIds ?? [],
		model: raw.model,
		planModel: raw.planModel,
		actModel: raw.actModel,
		piperVoice: raw.piperVoice,
		whisperModel: raw.whisperModel,
		allowedCommands: raw.allowedCommands ?? [],
		workspace: raw.workspace,
		sandbox: raw.sandbox,
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

/**
 * Create the state directory (~/.gaia) with owner-only mode 0700.
 * Everything inside — conversation logs, MEMORY.md, the FTS recall index,
 * research dumps — routinely contains secrets users paste to the agent (API
 * keys, credentials, personal data). mkdirSync's default is 0755, which would
 * let any local user read them on a multi-user host, so force 0700.
 */
export function ensureStateDir(): void {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
}

/** Set the default model: update the in-memory config AND persist it. */
export function setModel(config: Config, model: Config["model"]): void {
	config.model = model;
	updateConfigFile((raw) => {
		raw.model = model;
	});
}
