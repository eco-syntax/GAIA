import { loadConfig, stateDir } from "./config.js";
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
import { ChatSessions, refreshModelCatalog, runDelegate, turnOutcome, type TurnOutcome } from "./session.js";
import { takePendingMemoryUpdate, pendingMemoryStaged, approveStagedMemory, dropStagedMemory, loadMemory, memoryFileForChat } from "./memory.js";
import { createPendingLink, consumeLink, whoami } from "./identity.js";
import { webTools } from "./web.js";
import { startScheduler } from "./schedules.js";
import { loadSchedules, listSchedules } from "./scheduleStore.js";
import { synthesize, ttsAvailable } from "./tts.js";
import { transcribe, sttAvailable } from "./stt.js";
import { chatKey, type ChatMessage, type ChatRef, type InlineButton, type Platform } from "./platform.js";
import { saveAttachment } from "./attachments.js";
import { basename } from "node:path";
import { bashGate } from "./security.js";
import { PLAN_PROMPT, ACT_PROMPT, MODE_ENDED } from "./plan.js";
import { describeSandbox, enterSandbox, isContained, resolveSandboxMode, UNSAFE_FLAG, workspaceDir, type SandboxMode } from "./sandbox.js";

const unsafeFlag = process.argv.includes(UNSAFE_FLAG);
const sandbox: SandboxMode = resolveSandboxMode(loadConfig().sandbox, unsafeFlag);
const workspace = workspaceDir(loadConfig().workspace);

// Startup enforcement: an unsandboxed agent is the exception, and it must be
// typed, not defaulted. Inside a container GAIA_SANDBOX=docker is set by the
// image; bwrap re-execs below; anything else refuses unless --unsafe.
if (!isContained(sandbox)) {
	if (sandbox === "off" && !unsafeFlag) {
		console.error(
			`GAIA refused to start unsandboxed.\n` +
				`Run it in a container (docker compose up — see README), install bubblewrap for the\n` +
				`bwrap sandbox (sudo apt install bubblewrap), or pass ${UNSAFE_FLAG} to run bare\n` +
				`(the agent then sees the host filesystem it runs on — know what that means).`,
		);
		process.exit(1);
	}
	if (sandbox === "off" && unsafeFlag) {
		console.error("\x1b[31m⚠ UNSANDBOXED: the agent can read and write the host filesystem it runs on.\x1b[0m");
		console.error("\x1b[31m  Prefer the container or bwrap; see the README. This banner prints every start.\x1b[0m");
	}
	// enterSandbox re-execs under bwrap and never returns; the exit code is the
	// gateway's own, so the systemd unit's Restart= keeps working. The re-exec
	// argv is the full original command line (loader flags + script + args).
	const exitCode = await enterSandbox(
		sandbox,
		workspace,
		[...process.execArgv, ...process.argv.slice(1)],
	);
	process.exit(exitCode);
}

const config = loadConfig();
console.log(describeSandbox(sandbox, workspace));
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

// ---- /model inline menu -----------------------------------------------------
// Two-level navigation instead of a long pasteable list: first pick a provider,
// then a model, all by tapping buttons. Callback payloads are pipe-delimited:
// Telegram silently truncates callback_data past 64 bytes, and JSON's braces and
// quotes push long specs (e.g. "bedrock/us.anthropic.claude-3-5-sonnet-20241022-v2:0")
// over the limit. "set|<provider>/<id>" leaves ~58 bytes of headroom for the id;
// anything that still wouldn't fit is skipped rather than rendered as a dead button.
const MODELS_PER_PAGE = 10;
const cb = (a: string, value?: string): string | null => {
	const data = value === undefined ? a : `${a}|${value}`;
	return Buffer.byteLength(data) <= 64 ? data : null;
};

/** Parse a callback payload back into { a: action, p?: provider, n?: page, s?: spec }.
 * Wire codes are terse ("p", "pg" — callback_data is capped at 64 bytes); they
 * are normalized to the full names handleCallback dispatches on. */
function parseCb(data: string): { a: string; p?: string; n?: number; s?: string } | undefined {
	const [a, ...parts] = data.split("|");
	const value = parts.join("|");
	switch (a) {
		case "pg": {
			const n = Number(parts[1]);
			if (!parts[0] || !Number.isFinite(n)) return undefined;
			return { a: "page", p: parts[0], n };
		}
		case "set": return value ? { a, s: value } : undefined;
		case "p": return value ? { a: "provider", p: value } : undefined;
		case "cancel":
		case "providers":
			return { a };
		default:
			return undefined;
	}
}

/** List every selectable "provider/id" spec, for plain-text platforms that
 * can't show the interactive keyboard menu. */
async function allModelSpecs(): Promise<string[]> {
	const out: string[] = [];
	for (const p of await chats.providers()) {
		for (const m of await chats.models(p)) out.push(m.spec);
	}
	return out;
}

/** Provider-selection page — the first page /model shows, with the current model. */
async function providerMenu(): Promise<{ text: string; rows: InlineButton[][] }> {
	const providers = await chats.providers();
	const rows: InlineButton[][] = [];
	for (const p of providers) {
		const data = cb("p", p);
		if (!data) {
			console.warn(`skipping provider button (callback data too long): ${p}`);
			continue;
		}
		rows.push([{ text: p, callback_data: data }]);
	}
	rows.push([{ text: "✖ Cancel", callback_data: "cancel" }]);
	const body =
		providers.length === 0
			? "No providers in the model catalog yet."
			: "Choose a provider:";
	return {
		text: `Current model: ${await chats.currentModel()}\n\n${body}`,
		rows,
	};
}

/** One page of a provider's model list, with prev/next/back/cancel navigation. */
async function modelMenu(provider: string, page: number): Promise<{ text: string; rows: InlineButton[][] }> {
	const models = await chats.models(provider);
	const pages = Math.max(1, Math.ceil(models.length / MODELS_PER_PAGE));
	const current = Math.min(Math.max(0, page), pages - 1);
	const slice = models.slice(current * MODELS_PER_PAGE, (current + 1) * MODELS_PER_PAGE);
	const rows: InlineButton[][] = [];
	for (const m of slice) {
		const data = cb("set", m.spec);
		if (!data) {
			console.warn(`skipping model button (callback data too long): ${m.spec}`);
			continue;
		}
		rows.push([{ text: m.label, callback_data: data }]);
	}
	const nav: InlineButton[] = [];
	if (current > 0) {
		const data = cb("pg", `${provider}|${current - 1}`);
		if (data) nav.push({ text: "‹ Prev", callback_data: data });
	}
	if (current < pages - 1) {
		const data = cb("pg", `${provider}|${current + 1}`);
		if (data) nav.push({ text: "Next ›", callback_data: data });
	}
	if (nav.length) rows.push(nav);
	rows.push([
		{ text: "‹ Back", callback_data: "providers" },
		{ text: "✖ Cancel", callback_data: "cancel" },
	]);
	const header =
		models.length === 0
			? `No models found for provider "${provider}".`
			: pages > 1
				? `${provider} — choose a model (page ${current + 1}/${pages}):`
				: `${provider} — choose a model:`;
	return { text: header, rows };
}

/** Inline-button press: navigate the /model menu, or apply a model switch. */
async function handleCallback(ref: ChatRef, press: { id: string; data: string; messageId?: string }): Promise<void> {
	const platform = platforms[ref.platform]!;
	const action = parseCb(press.data);
	if (!action) {
		await platform.answerCallback?.(press.id, "Unknown action");
		return;
	}
	if (action.a === "cancel") {
		await platform.answerCallback?.(press.id, "Cancelled");
		if (press.messageId !== undefined) await platform.deleteMessage(ref, press.messageId);
		return;
	}
	if (action.a === "providers") {
		await platform.answerCallback?.(press.id);
		if (press.messageId !== undefined && platform.editMenu) {
			const menu = await providerMenu();
			await platform.editMenu(ref, press.messageId, menu.text, menu.rows);
		}
		return;
	}
	if (action.a === "provider" && action.p) {
		await platform.answerCallback?.(press.id);
		if (press.messageId !== undefined && platform.editMenu) {
			const menu = await modelMenu(action.p, 0);
			await platform.editMenu(ref, press.messageId, menu.text, menu.rows);
		}
		return;
	}
	if (action.a === "page" && action.p && action.n !== undefined) {
		await platform.answerCallback?.(press.id);
		if (press.messageId !== undefined && platform.editMenu) {
			const menu = await modelMenu(action.p, action.n);
			await platform.editMenu(ref, press.messageId, menu.text, menu.rows);
		}
		return;
	}
	if (action.a === "set" && action.s) {
		const err = await chats.switchModel(action.s);
		if (err) {
			await platform.answerCallback?.(press.id, err.slice(0, 200));
		} else {
			await platform.answerCallback?.(press.id, `Model set to ${action.s}`);
			if (press.messageId !== undefined && platform.editMenu) {
				await platform.editMenu(ref, press.messageId, `✅ Model set to ${action.s} — active conversations continue on it.`, []);
			}
		}
		return;
	}
	await platform.answerCallback?.(press.id, "Unknown action");
}

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
	platforms.telegram = createTelegramPlatform(config.telegramBotToken, config.allowedChatIds ?? [], config.allowedTelegramUserIds ?? []);
	// Issue #60: allow-listing a group without a sender list silently ignores
	// all group messages (the transport fails closed) — say so loudly here.
	const groupIds = (config.allowedChatIds ?? []).filter((id) => id.startsWith("-"));
	if (groupIds.length > 0 && (config.allowedTelegramUserIds ?? []).length === 0) {
		console.warn(
			`Telegram: group chat(s) ${groupIds.join(", ")} are allow-listed but allowedTelegramUserIds is empty — group messages are IGNORED (fail-closed, issue #60). Add the Telegram user ids who may act there, e.g. "allowedTelegramUserIds": [123456789].`,
		);
	}
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
		{ command: "plan", description: "Toggle plan mode (read-only planning + write_plan)" },
		{ command: "act", description: "Implement the plan in this session (bash approved)" },
		{ command: "done", description: "Exit plan/act mode, re-lock bash" },
		{ command: "delegate", description: "Implement a plan file in a fresh session (/delegate <file>)" },
		{ command: "link", description: "Link this chat to another chat's identity (/link [code])" },
		{ command: "whoami", description: "Show the linked identity" },
		{ command: "status", description: "Show sandbox, model, and bash state" },
		{ command: "stop", description: "Interrupt the current turn" },
		{ command: "model", description: "Show or switch the model (/model [provider/id])" },
		{ command: "refresh", description: "Reload models.json and provider catalogs" },
		{ command: "restart", description: "Restart the gateway service" },
		{ command: "bash", description: "Approve or lock bash (/bash, /bash off, /bash force)" },
	]);
}
console.log(`gaia-gateway running (state: ${stateDir}), platforms: ${Object.keys(platforms).join(", ")}, ${listSchedules().length} schedules`);

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
	if (prompt === "/plan") {
		// Toggle plan mode (read-only exploration + planning). No task argument —
		// the task arrives as normal conversation. Mirrors Cline/Codex/OpenCode:
		// same session, conversation persists across the switch. The only thing
		// that changes is the tool surface (write_plan added) + steering prompt.
		const session = await chats.get(ref);
		const mode = chats.modeOf(ref);
		if (mode === "plan") {
			chats.setMode(ref, undefined);
			chats.applyMode(session, ref);
			await chats.swapModel(ref, undefined);
			await session.sendCustomMessage({ customType: "plan-mode", content: MODE_ENDED, display: false }, { triggerTurn: false });
			await platform.sendText(ref, "Exited plan mode.");
		} else {
			chats.setMode(ref, "plan");
			chats.applyMode(session, ref);
			await chats.swapModel(ref, "plan");
			await session.sendCustomMessage({ customType: "plan-mode", content: PLAN_PROMPT, display: false }, { triggerTurn: false });
			await platform.sendText(ref, "📋 Plan mode on. Explore and refine a plan in conversation; write it to disk with write_plan. /plan again to exit, /act to implement here, or /delegate <file> to implement in a fresh session.");
		}
		return;
	}
	if (prompt === "/act") {
		// Enter act mode: implement the agreed plan in this same session.
		// Bash is approved (the /act invocation is the approval gesture, same
		// as /bash but with implementation as the stated goal). write_plan is
		// removed from the tool set — planning is done.
		const session = await chats.get(ref);
		chats.setMode(ref, "act");
		chats.applyMode(session, ref);
		bashGate.trust(chatId);
		await chats.swapModel(ref, "act");
		await session.sendCustomMessage({ customType: "act-mode", content: ACT_PROMPT, display: false }, { triggerTurn: false });
		await platform.sendText(ref, "🔧 Act mode on. Bash is fully approved (including destructive commands) — implement the plan. /done when finished.");
		return;
	}
	if (prompt === "/done") {
		// Exit act (or plan) mode back to default. Re-lock bash so the session
		// returns to its normal gated state.
		const mode = chats.modeOf(ref);
		if (!mode) {
			await platform.sendText(ref, "Not in plan or act mode.");
			return;
		}
		const session = await chats.get(ref);
		chats.setMode(ref, undefined);
		chats.applyMode(session, ref);
		bashGate.block(chatId);
		await chats.swapModel(ref, undefined);
		await session.sendCustomMessage({ customType: "mode-ended", content: MODE_ENDED, display: false }, { triggerTurn: false });
		await platform.sendText(ref, mode === "act" ? "Exited act mode. Bash re-locked." : "Exited plan mode.");
		return;
	}
	if (prompt.startsWith("/delegate ")) {
		// Spawn a fresh headless session seeded with just the plan file — no
		// chat history — so a long planning conversation doesn't blow the
		// context budget of a frugal local model. /delegate is the approval:
		// the spawned session may write freely, then exits and reports back.
		const planFile = prompt.slice("/delegate ".length).trim();
		if (!planFile) {
			await platform.sendText(ref, "Usage: /delegate <plan-file> (the filename write_plan saved, e.g. add-login.md).");
			return;
		}
		const stopTyping = startTypingIndicator(platform, ref);
		try {
			const out = await runDelegate(config, planFile);
			await deliver(ref, out);
		} finally {
			activeTurns.delete(chatId);
			stopTyping();
		}
		return;
	}
	if (prompt === "/model") {
		// Two-level interactive menu (Telegram inline keyboards); other platforms
		// fall back to a plain list. Either way the current model is shown (issue #90).
		if (platform.sendMenu) {
			const menu = await providerMenu();
			await platform.sendMenu(ref, menu.text, menu.rows);
		} else {
			await platform.sendText(
				ref,
				`Current model: ${await chats.currentModel()}\n\nAvailable models:\n${(await allModelSpecs()).join("\n")}\n\nSwitch with /model provider/id`,
			);
		}
		return;
	}
	if (prompt.startsWith("/model ")) {
		const arg = prompt.slice(6).trim();
		if (!arg) {
			await platform.sendText(
				ref,
				`Current model: ${await chats.currentModel()}\n\nAvailable models:\n${(await allModelSpecs()).join("\n")}\n\nSwitch with /model provider/id`,
			);
		} else {
			const err = await chats.switchModel(arg);
			await platform.sendText(ref, err ?? `Model set to ${arg} — active conversations continue on it`);
		}
		return;
	}
	if (prompt === "/refresh") {
		const err = await refreshModelCatalog();
		await platform.sendText(ref, err ? `Reload failed:\n${err}` : "Reloaded models.json and provider catalogs.");
		return;
	}
	if (prompt === "/start" || prompt === "/new") {
		chats.reset(ref);
		bashGate.reset(chatId);
		await platform.sendText(ref, `Fresh session started — model: ${await chats.currentModel()}`);
		return;
	}
	if (prompt === "/restart") {
		// Ack first: the HTTP round-trip flushes before we die. The service unit
		// runs with Restart=on-failure, so exit(1) makes the supervisor bring the
		// gateway back with the current code (new prompts, tools) in effect.
		await platform.sendText(ref, "Restarting the gateway…");
		process.exit(1);
	}
	if (prompt === "/bash" || prompt === "/bash on" || prompt === "/bash off" || prompt === "/bash force") {
		// Bash stays locked in plan mode — write access is the one thing plan
		// mode exists to withhold. Use /act (which approves bash and sets
		// implementation as the goal) or /plan to exit first.
		if (chats.modeOf(ref) === "plan" && prompt !== "/bash off") {
			await platform.sendText(ref, "Bash is locked in plan mode. Run /act to implement the plan (bash is approved there), or /plan again to exit plan mode first.");
			return;
		}
		if (prompt === "/bash force") {
			// One-shot destructive bypass: the destructive tier refused a command
			// the user does want to run, so they re-confirm here. Approves the next
			// single command (destructive or not) on top of the current approval,
			// then reverts. Opens the gate too if it was closed.
			if (bashGate.blocked(chatId)) bashGate.allow(chatId);
			bashGate.forceNext(chatId);
			await platform.sendText(
				ref,
				"⚠️ Bash force on: the next command the agent runs (including destructive ones) is approved once, then this reverts to normal /bash approval. Use it only for the specific command you just reviewed.",
			);
			return;
		}
		if (prompt === "/bash on" || (prompt === "/bash" && bashGate.blocked(chatId))) {
			bashGate.allow(chatId);
			await platform.sendText(
				ref,
				"⚠️ Security warning: bash is now ENABLED for this session. The agent can run any non-destructive shell command as your user until a new session (/new) starts; destructive commands (rm -r, sudo, mkfs, git push --force, …) still need /bash force. This weakens the prompt-injection guard, so only approve if you trust the agent's current inputs. Turn it back off with /bash off.",
			);
		} else {
			bashGate.block(chatId);
			await platform.sendText(
				ref,
				"Bash is now locked again for this session — the agent must ask you before every command.",
			);
		}
		return;
	}
	if (prompt === "/memory") {
		const staged = pendingMemoryStaged(memoryFileForChat(ref));
		const snapshot = loadMemory(memoryFileForChat(ref));
		await platform.sendText(
			ref,
			`Memory:\n${snapshot || "(empty)"}\n\nPending approval:\n${staged.map((l) => `- ${l}`).join("\n") || "(none)"}\n\n/memory-approve saves pending entries; /memory-deny discards them.`,
		);
		return;
	}
	if (prompt === "/memory-approve" || prompt === "/memory-deny") {
		const approve = prompt === "/memory-approve";
		const entries = approve
			? approveStagedMemory(memoryFileForChat(ref))
			: dropStagedMemory(memoryFileForChat(ref));
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
	if (prompt === "/status") {
		const lines = [
			`Sandbox: ${describeSandbox(sandbox, workspace)}`,
			`Model: ${await chats.currentModel()}`,
			`Bash: ${bashGate.blocked(chatId) ? "locked (approve with /bash)" : "approved for this session"}`,
		];
		await platform.sendText(ref, lines.join("\n"));
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
		// Inline-button press (the Telegram /model menu): handle it like any other
		// message — it interrupts a running turn and is serialized into the chat's
		// chain so a model switch can't race a live turn.
		if (msg.callback) {
			const chatId = chatKey(msg.ref);
			const active = activeTurns.get(chatId);
			if (active) await active();
			enqueue(chatId, () =>
				handleCallback(msg.ref, msg.callback!).catch((err) => {
					console.error("callback failed:", err);
					return deliver(msg.ref, `Error: request failed — ${describeError(err)}. Please resend.`);
				}),
			);
			return;
		}
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
		// Download any attached files into this chat's attachment inbox and tell
		// the agent what arrived so it can read them with open_attachment. Text
		// captions ride along; a file-only message still reaches the agent instead
		// of being dropped (issue #108).
		if (msg.attachments?.length && platform.getAttachment) {
			const files: string[] = [];
			for (const att of msg.attachments) {
				try {
					const { path } = await saveAttachment(msg.ref, att, platform);
					files.push(basename(path)); // the on-disk name the agent can open
				} catch (err) {
					console.error("attachment download failed:", err);
				}
			}
			if (files.length) {
				const listing = files.map((f) => `- ${f}`).join("\n");
				prompt = prompt
					? `${prompt}\n\n(The user attached file(s):\n${listing}\nUse open_attachment to read them.)`
					: `The user sent file attachment(s) with no message text:\n${listing}\nRead them with open_attachment and respond appropriately.`;
			}
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
// revoked token) still logs and keeps the others running.
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