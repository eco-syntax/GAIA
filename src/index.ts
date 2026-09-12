import { loadConfig, stateDir, addAllowedCommand } from "./config.js";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// Node's global fetch ignores HTTPS_PROXY by default; telegram.ts and web.ts
// use undici's fetch, which honors HTTP(S)_PROXY/NO_PROXY via this agent.
// allowH2:false — Telegram's HTTP/2 endpoint kills long-poll streams mid-flight
// (~every 2 min), losing getUpdates responses and churning the poll loop.
setGlobalDispatcher(new EnvHttpProxyAgent({ allowH2: false }));
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
if (proxyUrl) console.log(`using proxy ${proxyUrl}`);
import { deleteMessage, getVoice, pollMessages, sendMessage, setMyCommands, sendTyping, sendVoice } from "./telegram.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ChatSessions, runOneShot, turnOutcome, type TurnOutcome } from "./session.js";
import { takePendingMemoryUpdate } from "./memory.js";
import { webTools } from "./web.js";
import { startScheduler } from "./schedules.js";
import { initScheduleStore } from "./scheduleStore.js";
import { synthesize, ttsAvailable } from "./tts.js";
import { transcribe, sttAvailable } from "./stt.js";

const config = loadConfig();
initScheduleStore(config.schedules);
const chats = new ChatSessions(config);
const tools = webTools();
const useTts = config.piperVoice ? ttsAvailable(config.piperVoice) : false;
if (config.piperVoice && !useTts) console.warn("piper not found or voice model missing; voice replies disabled");
const useStt = config.whisperModel ? sttAvailable(config.whisperModel) : false;
if (config.whisperModel && !useStt) console.warn("whisper.cpp not found or model missing; voice messages ignored");

/** Undici hides the real network reason in `err.cause`; surface it so the user
 * sees why the turn failed instead of a bare "TypeError: fetch failed". */
function describeError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const cause = (err as { cause?: unknown }).cause;
	if (cause instanceof Error && cause.message) {
		const code = (cause as { code?: string }).code;
		return code ? `${cause.message} (${code})` : cause.message;
	}
	return err.message;
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
async function deliverOutcome(chatId: number, outcome: TurnOutcome, voice: boolean): Promise<void> {
	if (outcome.error) {
		if (outcome.error === "turn aborted") return;
		await deliver(chatId, `Model error: ${outcome.error}`);
		return;
	}
	await deliver(chatId, outcome.text ?? "(no response)", voice);
}

async function deliver(chatId: number, text: string, voice = false): Promise<void> {
	if (voice && useTts && config.piperVoice) {
		try {
			const { data, mime } = await synthesize(text, config.piperVoice);
			if (mime === "audio/ogg") {
				await sendVoice(config.telegramBotToken, chatId, data);
				return;
			}
		} catch (err) {
			console.error("tts failed, sending text:", err);
		}
	}
	await sendMessage(config.telegramBotToken, chatId, text);
}

/** Show "typing" until the returned stop function runs. */
function startTypingIndicator(token: string, chatId: number): () => void {
	void sendTyping(token, chatId);
	const timer = setInterval(() => void sendTyping(token, chatId), 4500);
	return () => clearInterval(timer);
}

const TOOL_ICONS: Record<string, string> = { websearch: "🔍", fetchpage: "🌐", bash: "⚙️", read: "📄", schedule: "🔁" };

/** Send a small status message when a tool starts; delete it when it ends. */
function watchToolActivity(
	session: ReturnType<typeof Object>,
	token: string,
	chatId: number,
): () => void {
	const pending = new Map<string, number>();
	const unsub = session.subscribe((event: { type: string; toolName?: string; toolCallId?: string; args?: { query?: string; url?: string; command?: string } }) => {
		if (event.type === "tool_execution_start" && event.toolCallId) {
			const icon = TOOL_ICONS[event.toolName ?? ""] ?? "🔧";
			const detail = event.args?.query ?? event.args?.url ?? event.args?.command ?? "";
			void sendMessage(token, chatId, `${icon} ${event.toolName}${detail ? `: ${String(detail).slice(0, 100)}` : "…"}`)
				.then((id) => pending.set(event.toolCallId!, id))
				.catch(() => {});
		} else if (event.type === "tool_execution_end" && event.toolCallId) {
			const messageId = pending.get(event.toolCallId);
			if (messageId) {
				pending.delete(event.toolCallId);
				void deleteMessage(token, chatId, messageId);
			}
		}
	});
	return () => {
		unsub();
		for (const id of pending.values()) void deleteMessage(token, chatId, id);
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

startScheduler(
	config,
	(chatId, text) => deliver(chatId, text),
	// Hermes-style cronjobs post in isolation and leave the agent with no memory of
	// them. Append each result to the chat's session log (same pattern as memory) so
	// follow-up questions are grounded in what the task actually found.
	async (chatId, content) => {
		const session = await chats.get(chatId);
		await session.sendCustomMessage(
			{ customType: "scheduled_task", content, display: false },
			{ triggerTurn: false },
		);
	},
);
// Surface the chat commands in Telegram's popup slash-command list.
void setMyCommands(config.telegramBotToken, [
	{ command: "new", description: "Start a fresh session" },
	{ command: "plan", description: "One-shot build plan for an idea" },
	{ command: "stop", description: "Interrupt the current turn" },
	{ command: "model", description: "Show or switch the model (/model [provider/id])" },
]);
console.log(`pi-gateway running (state: ${stateDir}), ${config.schedules.length} schedules`);

// Turns on one chat must not interleave (shared session history), so each chat
// has a serial queue. Commands that must land mid-turn (/stop) bypass it — the
// gateway keeps polling while a turn runs instead of awaiting it serially.
const chains = new Map<number, Promise<void>>();
/** Abort hook for the turn currently running in each chat. */
const activeTurns = new Map<number, () => Promise<void>>();

function trackTurn(chatId: number, session: { abort(): Promise<void> }): void {
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
function enqueue(chatId: number, task: () => Promise<void>): void {
	const next = (chains.get(chatId) ?? Promise.resolve()).then(task, task);
	chains.set(chatId, next);
	next.finally(() => {
		if (chains.get(chatId) === next) chains.delete(chatId);
	});
}

async function handleMessage(chatId: number, prompt: string, voice: boolean): Promise<void> {
	if (prompt.startsWith("/plan ")) {
		const stopTyping = startTypingIndicator(config.telegramBotToken, chatId);
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
			await deliver(chatId, out);
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
			await sendMessage(config.telegramBotToken, chatId, `Available models:\n${models.join("\n")}\n\nSwitch with /model provider/id`);
		} else {
			const err = await chats.switchModel(arg);
			await sendMessage(config.telegramBotToken, chatId, err ?? `Model set to ${arg} — new sessions use it`);
		}
		return;
	}
	if (prompt === "/start" || prompt === "/new") {
		chats.reset(chatId);
		await sendMessage(config.telegramBotToken, chatId, "Fresh session started");
		return;
	}
	if (prompt.startsWith("/allow ")) {
		const pattern = prompt.slice(7).trim();
		if (!pattern) {
			await sendMessage(config.telegramBotToken, chatId, "Usage: /allow <prefix> (e.g. /allow curl *)");
		} else {
			addAllowedCommand(config, pattern);
			await sendMessage(config.telegramBotToken, chatId, `Allowed: ${pattern}`);
		}
		return;
	}
	const session = await chats.get(chatId);
	const modelWarning = chats.takeWarning(chatId);
	if (modelWarning) await sendMessage(config.telegramBotToken, chatId, `⚠️ ${modelWarning}`);
	const stopTyping = startTypingIndicator(config.telegramBotToken, chatId);
	const stopWatching = watchToolActivity(session, config.telegramBotToken, chatId);
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
		await deliverOutcome(chatId, turnOutcome(session, before), voice);
	} finally {
		activeTurns.delete(chatId);
		stopTyping();
		stopWatching();
	}
}

for await (const { chatId, text: rawText, voiceFileId } of pollMessages(config.telegramBotToken, config.allowedChatIds, controller.signal)) {
	try {
		let prompt = rawText ?? "";
		if (voiceFileId) {
			if (!useStt) {
				await sendMessage(config.telegramBotToken, chatId, "Voice messages are disabled — set whisperModel in the config.");
				continue;
			}
			const stopTyping = startTypingIndicator(config.telegramBotToken, chatId);
			try {
				const ogg = await getVoice(config.telegramBotToken, voiceFileId);
				prompt = await transcribe(ogg, config.whisperModel!);
			} finally {
				stopTyping();
			}
			if (!prompt) continue; // empty/silent voice note
		}
		// Interrupt-and-redirect: a new message aborts the running turn first
		// (Hermes-style), so users never queue behind a runaway turn.
		const active = activeTurns.get(chatId);
		if (active) await active();
		if (prompt === "/stop") {
			// The interrupt above may have already finished the turn and cleaned
			// up its hook; fall back to the pre-abort snapshot so /stop never
			// claims "Nothing running" right after it stopped a turn.
			const abort = activeTurns.get(chatId) ?? active;
			if (abort) {
				await abort();
				await sendMessage(config.telegramBotToken, chatId, "Stopped.");
			} else {
				await sendMessage(config.telegramBotToken, chatId, "Nothing running.");
			}
			continue;
		}
		enqueue(chatId, () =>
			handleMessage(chatId, prompt, Boolean(voiceFileId)).catch((err) => {
				console.error("turn failed:", err);
				return deliver(chatId, `Error: request failed — ${describeError(err)}. Please resend.`);
			}),
		);
	} catch (err) {
		console.error("message handling failed:", err);
		await deliver(chatId, `Error: request failed — ${describeError(err)}. Please resend.`).catch(() => {});
	}
}
