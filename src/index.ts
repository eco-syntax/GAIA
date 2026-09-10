import { loadConfig, stateDir, addAllowedCommand } from "./config.js";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// Node's global fetch ignores HTTPS_PROXY by default; telegram.ts and web.ts
// use undici's fetch, which honors HTTP(S)_PROXY/NO_PROXY via this agent.
setGlobalDispatcher(new EnvHttpProxyAgent());
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
if (proxyUrl) console.log(`using proxy ${proxyUrl}`);
import { deleteMessage, getVoice, pollMessages, sendMessage, sendTyping, sendVoice } from "./telegram.js";
import { ChatSessions, lastAssistantText, runOneShot } from "./session.js";
import { takePendingMemoryUpdate } from "./memory.js";
import { webTools } from "./web.js";
import { startScheduler } from "./schedules.js";
import { synthesize, ttsAvailable } from "./tts.js";
import { transcribe, sttAvailable } from "./stt.js";

const config = loadConfig();
const chats = new ChatSessions(config);
const tools = webTools();
const useTts = config.piperVoice ? ttsAvailable(config.piperVoice) : false;
if (config.piperVoice && !useTts) console.warn("piper not found or voice model missing; voice replies disabled");
const useStt = config.whisperModel ? sttAvailable(config.whisperModel) : false;
if (config.whisperModel && !useStt) console.warn("whisper.cpp not found or model missing; voice messages ignored");

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

const TOOL_ICONS: Record<string, string> = { websearch: "🔍", fetchpage: "🌐", bash: "⚙️", read: "📄" };

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

startScheduler(config, (chatId, text) => deliver(chatId, text));
console.log(`pi-gateway running (state: ${stateDir}), ${config.schedules.length} schedules`);

for await (const { chatId, text: rawText, voiceFileId } of pollMessages(config.telegramBotToken, config.allowedChatIds, controller.signal)) {
	// One turn at a time globally — awaiting serializes turns; concurrent
	// prompts on one session interleave history and duplicate replies.
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
		if (prompt.startsWith("/plan ")) {
				const stopTyping = startTypingIndicator(config.telegramBotToken, chatId);
				try {
					const out = await runOneShot(
						config,
						"You are a concise technical planner. Produce a numbered build plan with file paths and acceptance criteria. No prose padding.",
						prompt.slice(6),
						{ tools: ["read", "bash"], customTools: tools },
					);
					await deliver(chatId, out);
				} finally {
					stopTyping();
				}
				continue;
			}
			if (prompt === "/start" || prompt === "/new") {
				chats.reset(chatId);
				await sendMessage(config.telegramBotToken, chatId, "Fresh session started");
				continue;
			}
			if (prompt.startsWith("/allow ")) {
				const pattern = prompt.slice(7).trim();
				if (!pattern) {
					await sendMessage(config.telegramBotToken, chatId, "Usage: /allow <prefix> (e.g. /allow curl *)");
				} else {
					addAllowedCommand(config, pattern);
					await sendMessage(config.telegramBotToken, chatId, `Allowed: ${pattern}`);
				}
				continue;
			}
			const session = await chats.get(chatId);
			const stopTyping = startTypingIndicator(config.telegramBotToken, chatId);
			const stopWatching = watchToolActivity(session, config.telegramBotToken, chatId);
			try {
				await session.prompt(prompt);
				// Memory updates are appended to the log as custom messages (DeepSeek-harness
				// style), so they reach the next turn without a session restart.
				const memUpdate = takePendingMemoryUpdate();
				if (memUpdate) {
					await session.sendCustomMessage(
						{ customType: "memory", content: memUpdate, display: false },
						{ triggerTurn: false },
					);
				}
				await deliver(chatId, lastAssistantText(session), true);
			} finally {
				stopTyping();
				stopWatching();
			}
	} catch (err) {
		console.error("turn failed:", err);
		await deliver(chatId, `Error: ${err}`).catch(() => {});
	}
}
