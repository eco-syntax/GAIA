import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import { webTools } from "./web.js";
import { loadMemory, memoryTools } from "./memory.js";

const CHAT_SYSTEM_PROMPT = `You are Gaia (Green AI Assistant), an ecologically-minded AI agent designed to run on clean energy. You have tools (shell, files, web search/fetch, memory) and talk over Telegram.

Style: reply in 1-3 short sentences, like SMS. Plain prose, no markdown, no lists, no headers. Answer first. Offer depth; don't dump it.

Work: use tools for real actions and real facts. Run the thing, then report what actually happened. Never invent output you didn't get from a tool — say what blocked you instead. A working result, not a description of one.

Memory: save durable user facts and reusable techniques with the memory tool. Skip anything stale in a week — task logs, IDs, statuses. Use the recall tool to search past conversations when memory isn't enough.

Frugality is part of your identity: prefer the smallest model, shortest prompt, fewest tool calls that get the job done — wasted compute is wasted energy.`;
/** One pi session per chat, held in memory. Sessions persist to disk via SessionManager. */
export class ChatSessions {
	private sessions = new Map<number, AgentSession>();
	private modelRuntime: ModelRuntime | undefined;
	constructor(private config: Config) {}

	async get(chatId: number): Promise<AgentSession> {
		const existing = this.sessions.get(chatId);
		if (existing) return existing;
		if (!this.modelRuntime) this.modelRuntime = await ModelRuntime.create();
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: `${process.env.HOME}/.pi-gateway/agent`,
			systemPromptOverride: () => `${CHAT_SYSTEM_PROMPT}\n\nYour long-term memory (curated via the memory tool):\n${loadMemory() || "(empty — save what you learn about the user)"}`,
			appendSystemPromptOverride: () => [],
		});
		await loader.reload();
		const spec = this.config.model;
		let model = spec ? (this.modelRuntime.getModel(spec.provider, spec.id) ?? undefined) : undefined;
		// Local servers don't report their real context; let config override the
		// catalog guess so pi compacts before the server silently truncates.
		if (model && spec && (spec.contextWindow !== undefined || spec.maxTokens !== undefined)) {
			model = {
				...model,
				contextWindow: spec.contextWindow ?? model.contextWindow,
				maxTokens: spec.maxTokens ?? model.maxTokens,
			};
		}
		const { session } = await createAgentSession({
			modelRuntime: this.modelRuntime,
			model,
			thinkingLevel: "off",
			customTools: [...webTools(), ...memoryTools()],
			resourceLoader: loader,
			sessionManager: SessionManager.create(process.cwd(), `${process.env.HOME}/.pi-gateway/sessions/${chatId}`),
		});
		this.sessions.set(chatId, session);
		return session;
	}

	/** Drop the in-memory session so the next get() starts fresh. Log stays on disk. */
	reset(chatId: number): void {
		this.sessions.delete(chatId);
	}
}

/** Final assistant text of the last completed turn. */
export function lastAssistantText(session: AgentSession): string {
	const messages = session.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const text = (m as { content: { type: string; text?: string }[] }).content
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "(no response)";
}

/** Run a one-shot headless turn and return the final text. */
export async function runOneShot(
	config: Config,
	systemPrompt: string,
	prompt: string,
	options?: { tools?: string[]; customTools?: ToolDefinition[] },
): Promise<string> {
	const modelRuntime = await ModelRuntime.create();
	const spec = config.model;
	let model = spec ? (modelRuntime.getModel(spec.provider, spec.id) ?? undefined) : undefined;
	if (model && spec && (spec.contextWindow !== undefined || spec.maxTokens !== undefined)) {
		model = {
			...model,
			contextWindow: spec.contextWindow ?? model.contextWindow,
			maxTokens: spec.maxTokens ?? model.maxTokens,
		};
	}
	const { session } = await createAgentSession({
		modelRuntime,
		model,
		thinkingLevel: "off",
		tools: options?.tools,
		customTools: options?.customTools,
		sessionManager: SessionManager.inMemory(),
	});
	try {
		await session.prompt(systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt);
		return lastAssistantText(session);
	} finally {
		session.dispose();
	}
}
