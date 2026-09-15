import { loadConfig, stateDir, addAllowedCommand } from "./config.js";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// Node's global fetch ignores HTTPS_PROXY by default; the platform transports
// (telegram.ts, slack.ts, discord.ts, matrix.ts, web.ts) use undici's fetch,
// which honors HTTP(S)_PROXY/NO_PROXY via this agent.
// allowH2:false — Telegram's HTTP/2 endpoint kills long-poll streams mid-flight
// (~every 2 min), losing getUpdates responses and churning the poll loop.
setGlobalDispatcher(new EnvHttpProxyAgent({ allowH2: false }));
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
if (proxyUrl) console.log(`using proxy ${proxyUrl}`);
import { createTelegramPlatform, setMyCommands, deepestCause, errorCode } from "./telegram.js";
import { createSlackPlatform } from "./slack.js";
import { createDiscordPlatform } from "./discord.js";
import { createMatrixPlatform } from "./matrix.js";
import { toSpokenText } from "./format.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ChatSessions, runOneShot, turnOutcome, type TurnOutcome } from "./session.js";
import { takePendingMemoryUpdate, pendingMemoryStaged, approveStagedMemory, dropStagedMemory, loadMemory, memoryFileForChat } from "./memory.js";
import { createPendingLink, consumeLink, whoami } from "./identity.js";
import { webTools } from "./web.js";
import { startScheduler } from "./schedules.js";
import { loadSchedules, listSchedules } from "./scheduleStore.js";
import { synthesize, ttsAvailable } from "./tts.js";
import { transcribe, sttAvailable } from "./stt.js";
import { chatKey, type ChatMessage, type ChatRef, type Platform } from "./platform.js";

const config = loadConfig();
loadSchedules();
const chats = new ChatSessions(config);
const tools = webTools();
const useTts = config.piperVoice ? ttsAvailable(config.piperVoice) : false;
if (config.piperVoice && !useTts) console.warn("piper not found or voice model missing; voice replies disabled");
const useStt = config.whisperModel ? sttAvailable(config.whisperModel) : false;
if (config.whisperModel && !useStt) console.warn("whisper.cpp not found or model missing; voice messages ignored");

/** Undici hides the real network reason in `err.cause`; surface it so the user
 * sees why the turn failed instead of a bare "TypeError: fetch failed". The
 * cause-chain walk lives in telegram.ts (deepestCause/errorCode) — no second
 * copy here, and deepestCause sees past the one-level version's blind spot. */
function describeError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const deep = deepestCause(err);
	const message = deep instanceof Error && deep.message ? deep.message : err.message;
	const code = errorCode(err);
	return code ? `${message} (${code})` : message;
}

/** Upstream provider died mid-request (stream stall, timeout). pi's SDK retry
 * list doesn't cover "stalled", so these end the turn silently. */
const STALL_ERROR = /stalled|no data received|timed?.?out|timeout|connection.?(lost|reset|closed)/i;

/** One silent retry when the model stream dies before answering. Only when the
 * failed turn produced no tool results — a retry after side effects (shell
 * commands!) could double-execute them. Mirrors pi's own retry: drop the
 * errored assistant message, then continue from the queued user prompt. */
async function retryStalledTurn(session: Parameters<typeof turnOutcome>[0], before: number): Promise<void> {
	const outcome = turnOutcome(session, before);
	if (!outcome.error || !STALL_ERROR.test(outcome.error)) return;
	const failed = session.messages.slice(before);
	if (failed.some((m) => (m as { role?: string }).role === "toolResult")) return;
	console.warn(`model stream stalled with no tool side effects — retrying once: ${outcome.error}`);
	const messages = session.agent.state.messages;
	const last = messages[messages.length - 1] as { role?: string; stopReason?: string } | undefined;
	if (last?.role === "assistant" && last.stopReason === "error") messages.pop();
	await session.agent.continue();
}

/** Deliver the turn result. Failed turns report the error as plain text —
 * never as a synthesized voice note saying "(no response)". Aborted turns are
 * silent: /stop already told the user the turn was stopped. */
async function deliverOutcome(ref: ChatRef, outcome: TurnOutcome, voice: boolean): Promise<void> {
	if (outcome.error) {
		if (outcome.error === "turn aborted") return;
		await deliver(ref, `Model error: ${outcome.error}`);
		return;
	}
	await deliver(ref, outcome.text ?? "(no response)", voice);
}

async function deliver(ref: ChatRef, text: string, voice = false): Promise<void> {
	const platform = platforms[ref.platform];
	if (!platform) return;
	if (voice && useTts && config.piperVoice && platform.sendVoice) {
		try {
			// Voice notes speak plain prose: no markdown syntax read aloud, no
			// reasoning steps that a text reply would leave out.
			const { data, mime } = await synthesize(toSpokenText(text), config.piperVoice);
			if (mime === "audio/ogg") {
				await platform.sendVoice(ref, data, mime);
				return;
			}
		} catch (err) {
			console.error("tts failed, sending text:", err);
		}
	}
	await platform.sendText(ref, text);
}

/** Show "typing" until the returned stop function runs. */
function startTypingIndicator(platform: Platform, ref: ChatRef): () => void {
	void platform.sendTyping(ref);
	const timer = setInterval(() => void platform.sendTyping(ref), 4500);
	return () => clearInterval(timer);
}

const TOOL_ICONS: Record<string, string> = { websearch: "🔍", fetchpage: "🌐", bash: "⚙️", read: "📄", schedule: "🔁" };

/** Send a small status message when a tool starts; delete it when it ends. */
function watchToolActivity(
	session: AgentSession,
	platform: Platform,
	ref: ChatRef,
): () => void {
	const pending = new Map<string, string>();
	const unsub = session.subscribe((event: { type: string; toolName?: string; toolCallId?: string; args?: { query?: string; url?: string; command?: string } }) => {
		if (event.type === "tool_execution_start" && event.toolCallId) {
			const icon = TOOL_ICONS[event.toolName ?? ""] ?? "🔧";
			const detail = event.args?.query ?? event.args?.url ?? event.args?.command ?? "";
			void platform.sendText(ref, `${icon} ${event.toolName}${detail ? `: ${String(detail).slice(0, 100)}` : "…"}`)
				.then((id) => { if (id) pending.set(event.toolCallId!, id); })
				.catch(() => {});
		} else if (event.type === "tool_execution_end" && event.toolCallId) {
			const messageId = pending.get(event.toolCallId);
			if (messageId) {
				pending.delete(event.toolCallId);
				void platform.deleteMessage(ref, messageId);
			}
		}
	});
	return () => {
		unsub();
		for (const id of pending.values()) void platform.deleteMessage(ref, id);
	};
}

const controller = new AbortController();
let shuttingDown = false;
function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	controller.abort();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Platforms: every configured chat transport. loadConfig already validated
// credentials and fail-closed allow-lists for each.
// ---------------------------------------------------------------------------
const platforms: Record<string, Platform> = {};
if (config.telegramBotToken) {
	platforms.telegram = createTelegramPlatform(config.telegramBotToken, config.allowedChatIds ?? []);
}
if (config.slackBotToken && config.slackAppToken) {
	platforms.slack = createSlackPlatform(config.slackBotToken, config.slackAppToken, config.allowedSlackChatIds ?? []);
}
if (config.discordBotToken) {
	platforms.discord = createDiscordPlatform(config.discordBotToken, config.allowedDiscordChatIds ?? []);
}
if (config.matrixAccessToken && config.matrixHomeserver && config.matrixUserId) {
	platforms.matrix = createMatrixPlatform(config.matrixHomeserver, config.matrixUserId, config.matrixAccessToken, config.allowedMatrixRoomIds ?? []);
}

startScheduler(
	config,
	(ref, text) => deliver(ref, text),
	// Hermes-style cronjobs post in isolation and leave the agent with no memory of
	// them. Append each result to the chat's session log (same pattern as memory) so
	// follow-up questions are grounded in what the task actually found.
	async (ref, content) => {
		const session = await chats.get(ref);
		await session.sendCustomMessage(
			{ customType: "scheduled_task", content, display: false },
			{ triggerTurn: false },
		);
	},
);
// Surface the chat commands in Telegram's popup slash-command list.
if (platforms.telegram) {
	void setMyCommands(config.telegramBotToken!, [
		{ command: "new", description: "Start a fresh session" },
		{ command: "plan", description: "One-shot build plan for an idea" },
		{ command: "link", description: "Link this chat to another chat's identity (/link [code])" },
		{ command: "whoami", description: "Show the linked identity" },
		{ command: "stop", description: "Interrupt the current turn" },
		{ command: "model", description: "Show or switch the model (/model [provider/id])" },
	]);
}
console.log(`pi-gateway running (state: ${stateDir}), platforms: ${Object.keys(platforms).join(", ")}, ${listSchedules().length} schedules`);

// Turns on one chat must not interleave (shared session history), so each chat
// has a serial queue keyed by platform:chatId. Commands that must land
// mid-turn (/stop) bypass it — the gateway keeps polling while a turn runs
// instead of awaiting it serially.
const chains = new Map<string, Promise<void>>();
/** Abort hook for the turn currently running in each chat. */
const activeTurns = new Map<string, () => Promise<void>>();

function trackTurn(chatId: string, session: { abort(): Promise<void> }): void {
	activeTurns.set(chatId, async () => {
		try {
			await session.abort();
		} catch {
			// turn already finished
		}
	});
}

/** Run one message's handling without blocking the poll loop; per-chat turns
 * stay serialized, errors are reported to the chat instead of thrown. */
function enqueue(chatId: string, task: () => Promise<void>): void {
	const next = (chains.get(chatId) ?? Promise.resolve()).then(task, task);
	chains.set(chatId, next);
	next.finally(() => {
		if (chains.get(chatId) === next) chains.delete(chatId);
	});
}

async function handleMessage(msg: ChatMessage, prompt: string, voice: boolean): Promise<void> {
	const ref = msg.ref;
	const platform = platforms[ref.platform]!;
	const chatId = chatKey(ref);
	if (prompt.startsWith("/plan ")) {
		const stopTyping = startTypingIndicator(platform, ref);
		let planSession: AgentSession | undefined;
		try {
			const out = await runOneShot(
				config,
				"You are a concise technical planner. Produce a numbered build plan with file paths and acceptance criteria. No prose padding.",
				prompt.slice(6),
				{
					tools: ["read", "bash"],
					customTools: tools,
					onSession: (session) => {
						planSession = session;
						trackTurn(chatId, session);
					},
				},
			);
			// /stop already told the user; don't also deliver "Error: turn aborted".
			if (planSession && turnOutcome(planSession, 0).error === "turn aborted") return;
			await deliver(ref, out);
		} finally {
			activeTurns.delete(chatId);
			stopTyping();
		}
		return;
	}
	if (prompt === "/model" || prompt.startsWith("/model ")) {
		const arg = prompt.slice(6).trim();
		if (!arg) {
			const models = await chats.models();
			await platform.sendText(ref, `Available models:\n${models.join("\n")}\n\nSwitch with /model provider/id`);
		} else {
			const err = await chats.switchModel(arg);
			await platform.sendText(ref, err ?? `Model set to ${arg} — new sessions use it`);
		}
		return;
	}
	if (prompt === "/start" || prompt === "/new") {
		chats.reset(ref);
		await platform.sendText(ref, "Fresh session started");
		return;
	}
	if (prompt.startsWith("/allow ")) {
		const pattern = prompt.slice(7).trim();
		if (!pattern) {
			await platform.sendText(ref, "Usage: /allow <prefix> (e.g. /allow curl *)");
		} else {
			addAllowedCommand(config, pattern);
			await platform.sendText(ref, `Allowed: ${pattern}`);
		}
		return;
	}
	if (prompt === "/memory") {
		const staged = pendingMemoryStaged();
		const snapshot = loadMemory(memoryFileForChat(ref));
		await platform.sendText(
			ref,
			`Memory:\n${snapshot || "(empty)"}\n\nPending approval:\n${staged.map((l) => `- ${l}`).join("\n") || "(none)"}\n\n/memory-approve saves pending entries; /memory-deny discards them.`,
		);
		return;
	}
	if (prompt === "/memory-approve" || prompt === "/memory-deny") {
		const approve = prompt === "/memory-approve";
		const entries = approve ? approveStagedMemory(memoryFileForChat(ref)) : dropStagedMemory();
		if (entries.length === 0) {
			await platform.sendText(ref, "Nothing pending.");
			return;
		}
		const summary = entries.map((l) => `- ${l}`).join("\n");
		await platform.sendText(ref, `${approve ? "Saved to memory" : "Discarded"}:\n${summary}`);
		// Let a live session know, so the model doesn't re-stage or misreport.
		const live = chats.peek(ref);
		if (live) {
			await live.sendCustomMessage(
				{
					customType: "memory",
					content: approve ? `User approved memory entries:\n${summary}` : `User rejected memory entries:\n${summary}`,
					display: false,
				},
				{ triggerTurn: false },
			);
		}
		return;
	}
	if (prompt === "/link" || prompt.startsWith("/link ")) {
		// Identity linking is restricted to 1:1 DMs — never group chats.
		if (!msg.direct) {
			await platform.sendText(ref, "Identity linking works only in 1:1 direct messages between you and the agent.");
			return;
		}
		const code = prompt.slice(6).trim();
		if (!code) {
			const generated = createPendingLink(msg);
			await platform.sendText(
				ref,
				`Link code: ${generated}\n\nSend /link ${generated} in the chat you want to join to this one (or run /link there and enter the code here). The code expires in 10 minutes and works once.`,
			);
			return;
		}
		const res = consumeLink(code, msg);
		await platform.sendText(
			ref,
			res.ok
				? `Linked! This chat is now part of identity ${res.uid} — memory and recall are shared across the linked chats. Run /whoami to see them.`
				: `Could not link: ${res.error}`,
		);
		return;
	}
	if (prompt === "/whoami") {
		await platform.sendText(ref, whoami(ref));
		return;
	}
	const session = await chats.get(ref);
	const modelWarning = chats.takeWarning(ref);
	if (modelWarning) await platform.sendText(ref, `⚠️ ${modelWarning}`);
	const stopTyping = startTypingIndicator(platform, ref);
	const stopWatching = watchToolActivity(session, platform, ref);
	trackTurn(chatId, session);
	try {
		const before = session.messages.length;
		await session.prompt(prompt);
		await retryStalledTurn(session, before);
		// Memory updates are appended to the log as custom messages (DeepSeek-harness
		// style), so they reach the next turn without a session restart.
		const memUpdate = takePendingMemoryUpdate();
		if (memUpdate) {
			await session.sendCustomMessage(
				{ customType: "memory", content: memUpdate, display: false },
				{ triggerTurn: false },
			);
		}
		// Voice in → voice out; text stays text.
		await deliverOutcome(ref, turnOutcome(session, before), voice);
	} finally {
		activeTurns.delete(chatId);
		stopTyping();
		stopWatching();
	}
}

/** One incoming message from any platform: transcribe voice, interrupt the
 * running turn, then dispatch commands or enqueue a regular turn. */
async function onMessage(msg: ChatMessage): Promise<void> {
	const platform = platforms[msg.ref.platform];
	if (!platform) return;
	try {
		let prompt = msg.text ?? "";
		if (msg.voiceFileId) {
			if (!useStt || !platform.getVoice) {
				await platform.sendText(msg.ref, "Voice messages are disabled — set whisperModel in the config.");
				return;
			}
			const stopTyping = startTypingIndicator(platform, msg.ref);
			try {
				const ogg = await platform.getVoice(msg.voiceFileId);
				prompt = await transcribe(ogg, config.whisperModel!);
			} finally {
				stopTyping();
			}
			if (!prompt) return; // empty/silent voice note
		}
		// Interrupt-and-redirect: a new message aborts the running turn first
		// (Hermes-style), so users never queue behind a runaway turn.
		const chatId = chatKey(msg.ref);
		const active = activeTurns.get(chatId);
		if (active) await active();
		if (prompt === "/stop") {
			// The interrupt above may have already finished the turn and cleaned
			// up its hook; fall back to the pre-abort snapshot so /stop never
			// claims "Nothing running" right after it stopped a turn.
			const abort = activeTurns.get(chatId) ?? active;
			if (abort) {
				await abort();
				await platform.sendText(msg.ref, "Stopped.");
			} else {
				await platform.sendText(msg.ref, "Nothing running.");
			}
			return;
		}
		enqueue(chatId, () =>
			handleMessage(msg, prompt, Boolean(msg.voiceFileId)).catch((err) => {
				console.error("turn failed:", err);
				return deliver(msg.ref, `Error: request failed — ${describeError(err)}. Please resend.`);
			}),
		);
	} catch (err) {
		console.error("message handling failed:", err);
		await deliver(msg.ref, `Error: request failed — ${describeError(err)}. Please resend.`).catch(() => {});
	}
}

// Poll every configured platform concurrently. One platform dying (e.g. a
// revoked token) logs and keeps the others running.
for (const platform of Object.values(platforms)) {
	void (async () => {
		try {
			for await (const msg of platform.poll(controller.signal)) {
				await onMessage(msg);
			}
		} catch (err) {
			if (controller.signal.aborted) return;
			console.error(`${platform.id} poll loop failed:`, err);
		}
	})();
}