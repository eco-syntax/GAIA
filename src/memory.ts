import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./config.js";

// ============================================================================
// Long-term memory for a short-context agent. Two tools, no deps, no index:
//  - memory:   semantic memory. A single capped MEMORY.md injected into the
//              system prompt; the agent curates it with save/forget.
//  - recall:   episodic memory. Grep over persisted session logs — unlimited
//              lookback for zero standing token cost.
// ============================================================================

const MEMORY_FILE = join(stateDir, "MEMORY.md");
/** Hard cap: at a 32K context window this is ~500 tokens, 1.5% of budget. */
const MEMORY_CHAR_LIMIT = 8000;

export function loadMemory(): string {
	try {
		return readFileSync(MEMORY_FILE, "utf8").slice(0, MEMORY_CHAR_LIMIT);
	} catch {
		return "";
	}
}

export function memoryTools(): ToolDefinition[] {
	const memory = defineTool({
		name: "memory",
		label: "Memory",
		description:
			"Persistent long-term memory shown to you every conversation. Use for durable user facts (preferences, people, projects, environment quirks). Actions: 'save' appends a one-line fact, 'forget' removes lines containing a phrase.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("save"), Type.Literal("forget"), Type.Literal("list")]),
			content: Type.Optional(Type.String({ description: "One-line fact (save) or phrase to match (forget)" })),
		}),
		async execute(_id, params) {
			mkdirSync(stateDir, { recursive: true });
			const current = loadMemory();
			if (params.action === "list") {
				return { content: [{ type: "text" as const, text: current || "(empty)" }], details: undefined };
			}
			if (params.action === "save") {
				const line = (params.content ?? "").replace(/\n+/g, " ").trim();
				if (!line) return { content: [{ type: "text" as const, text: "Nothing to save." }], details: undefined };
				if (current.includes(line)) {
					return { content: [{ type: "text" as const, text: "Already remembered." }], details: undefined };
				}
				let next = `${current}${current && !current.endsWith("\n") ? "\n" : ""}- ${line}\n`;
				// ponytail: drop oldest lines when the cap is hit; per-section
				// budgets if memory ever grows past a few dozen lines.
				const lines = next.split("\n");
				while (next.length > MEMORY_CHAR_LIMIT && lines.length > 1) lines.shift();
				next = lines.join("\n").slice(-MEMORY_CHAR_LIMIT);
				writeFileSync(MEMORY_FILE, next);
				return { content: [{ type: "text" as const, text: "Saved to memory." }], details: undefined };
			}
			// forget
			const phrase = (params.content ?? "").trim();
			const kept = current
				.split("\n")
				.filter((l) => !phrase || !l.toLowerCase().includes(phrase.toLowerCase()));
			writeFileSync(MEMORY_FILE, kept.join("\n"));
			return {
				content: [{ type: "text" as const, text: `Removed ${current.split("\n").length - kept.length} line(s).` }],
				details: undefined,
			};
		},
	});

	const recall = defineTool({
		name: "recall",
		label: "Recall",
		description:
			"Search past conversation logs (all chats, all time). Use when you need something discussed before that isn't in your current context or MEMORY.md. Returns matching snippets with chat and date.",
		parameters: Type.Object({
			query: Type.String({ description: "Text to search for (case-insensitive)" }),
			limit: Type.Optional(Type.Number({ description: "Max snippets (default 5)" })),
		}),
		async execute(_id, params) {
			const sessionsDir = join(stateDir, "sessions");
			if (!existsSync(sessionsDir)) {
				return { content: [{ type: "text" as const, text: "No session logs yet." }], details: undefined };
			}
			const q = params.query.toLowerCase();
			const limit = params.limit ?? 5;
			const hits: string[] = [];
			// Layout: sessions/<chatId>/<uuid>.jsonl, one entry per line:
			// {type:"message", message:{role, content}, timestamp, ...}
			for (const chat of readdirSync(sessionsDir).sort().reverse()) {
				const chatDir = join(sessionsDir, chat);
				let logFiles: string[];
				try {
					logFiles = readdirSync(chatDir).filter((f) => f.endsWith(".jsonl"));
				} catch {
					continue; // not a directory
				}
				for (const file of logFiles) {
					for (const line of readFileSync(join(chatDir, file), "utf8").split("\n")) {
						if (!line.trim()) continue;
						let entry: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
						try {
							entry = JSON.parse(line);
						} catch {
							continue;
						}
						if (entry.type !== "message") continue;
						const text = (Array.isArray(entry.message?.content) ? entry.message.content : [])
							.map((b) => (b && typeof b === "object" && (b as { type?: string; text?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
							.join(" ");
						const at = text.toLowerCase().indexOf(q);
						if (at === -1) continue;
						hits.push(
							`[${chat} | ${entry.timestamp ?? "?"} | ${entry.message?.role}] …${text.slice(Math.max(0, at - 80), at + 200)}…`,
						);
						if (hits.length >= limit) break;
					}
					if (hits.length >= limit) break;
				}
				if (hits.length >= limit) break;
			}
			return {
				content: [{ type: "text" as const, text: hits.length ? hits.join("\n\n") : `No matches for "${params.query}".` }],
				details: undefined,
			};
		},
	});

	return [memory, recall];
}
