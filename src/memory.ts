import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stateDir, type Config } from "./config.js";

// ============================================================================
// Long-term memory for a short-context agent:
//  - memory:   semantic memory. A single capped MEMORY.md; snapshots are
//              appended to the session as custom messages (not prepended to
//              the system prompt); the agent curates it with save/forget.
//  - recall:   episodic memory. FTS5 full-text index over persisted session
//              logs (node:sqlite, no deps) plus one-shot LLM summarization of
//              the hits. Everything rides back as the tool result — a tool
//              message, never a system-prompt injection.
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

// ---------------------------------------------------------------------------
// FTS5 index over session logs (sessions/<chatId>/<uuid>.jsonl). Incremental:
// files are re-parsed only when mtime or size changed. ponytail: a mid-file
// rewrite that keeps size AND mtime identical is invisible; pi appends or
// rewrites with fresh mtimes, so that never happens in practice.
// ---------------------------------------------------------------------------
const RECALL_DB = join(stateDir, "recall.db");

let recallDb: DatabaseSync | undefined;

function openRecallDb(): DatabaseSync {
	if (recallDb) return recallDb;
	mkdirSync(stateDir, { recursive: true });
	const db = new DatabaseSync(RECALL_DB);
	db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(path UNINDEXED, chat UNINDEXED, ts UNINDEXED, role UNINDEXED, text)");
	db.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL, size INTEGER)");
	recallDb = db;
	return db;
}

function messageText(content: unknown): string {
	return (Array.isArray(content) ? content : [])
		.map((b) => (b && typeof b === "object" && (b as { type?: string; text?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
		.join(" ");
}

/** Bring the FTS5 index up to date with the session logs on disk. */
function indexSessionLogs(): void {
	const db = openRecallDb();
	const sessionsDir = join(stateDir, "sessions");
	if (!existsSync(sessionsDir)) return;
	const seen = new Set<string>();
	for (const chat of readdirSync(sessionsDir)) {
		const chatDir = join(sessionsDir, chat);
		let logFiles: string[];
		try {
			logFiles = readdirSync(chatDir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue; // not a directory
		}
		for (const file of logFiles) {
			const path = join(chatDir, file);
			seen.add(path);
			const st = statSync(path);
			const known = db.prepare("SELECT mtime, size FROM files WHERE path = ?").get(path) as
				| { mtime: number; size: number }
				| undefined;
			if (known && known.mtime === st.mtimeMs && known.size === st.size) continue;
			db.prepare("DELETE FROM chunks WHERE rowid IN (SELECT rowid FROM chunks WHERE path = ?)").run(path);
			const insert = db.prepare("INSERT INTO chunks (path, chat, ts, role, text) VALUES (?, ?, ?, ?, ?)");
			// One entry per line: {type:"message", message:{role, content}, timestamp, ...}
			for (const line of readFileSync(path, "utf8").split("\n")) {
				if (!line.trim()) continue;
				let entry: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (entry.type !== "message") continue;
				const text = messageText(entry.message?.content).trim();
				if (!text) continue;
				insert.run(path, chat, entry.timestamp ?? "", entry.message?.role ?? "", text);
			}
			db.prepare("INSERT OR REPLACE INTO files (path, mtime, size) VALUES (?, ?, ?)").run(path, st.mtimeMs, st.size);
		}
	}
	for (const { path } of db.prepare("SELECT path FROM files").all() as { path: string }[]) {
		if (!seen.has(path)) {
			db.prepare("DELETE FROM chunks WHERE rowid IN (SELECT rowid FROM chunks WHERE path = ?)").run(path);
			db.prepare("DELETE FROM files WHERE path = ?").run(path);
		}
	}
}

/** Quote each term so free-text queries can't inject FTS5 syntax; AND by default. */
function ftsQuery(q: string): string {
	return q
		.split(/\s+/)
		.filter(Boolean)
		.map((t) => `"${t.replaceAll('"', '""')}"`)
		.join(" ");
}

/** Latest memory-tool change, drained by the caller and appended to the session log. */
let pendingMemoryUpdate: string | null = null;

export function takePendingMemoryUpdate(): string | null {
	const p = pendingMemoryUpdate;
	pendingMemoryUpdate = null;
	return p;
}

export function memoryTools(config: Config): ToolDefinition[] {
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
				pendingMemoryUpdate = `Remembered: ${line}`;
				return { content: [{ type: "text" as const, text: "Saved to memory." }], details: undefined };
			}
			// forget
			const phrase = (params.content ?? "").trim();
			const kept = current
				.split("\n")
				.filter((l) => !phrase || !l.toLowerCase().includes(phrase.toLowerCase()));
			writeFileSync(MEMORY_FILE, kept.join("\n"));
			pendingMemoryUpdate = `Memory updated (removed ${current.split("\n").length - kept.length} line(s)). Current memory:\n${kept.join("\n").trim() || "(empty)"}`;
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
			"Search past conversation logs (all chats, all time). Use when you need something discussed before that isn't in your current context or MEMORY.md. Returns an LLM summary of what past conversations said about the query, plus the matching excerpts with chat and date.",
		parameters: Type.Object({
			query: Type.String({ description: "Search terms; every term must appear (AND). Use several specific keywords, not sentences." }),
			limit: Type.Optional(Type.Number({ description: "Max excerpts (default 5)" })),
		}),
		async execute(_id, params) {
			const sessionsDir = join(stateDir, "sessions");
			if (!existsSync(sessionsDir)) {
				return { content: [{ type: "text" as const, text: "No session logs yet." }], details: undefined };
			}
			indexSessionLogs();
			const match = ftsQuery(params.query);
			const noHits = `No matches for "${params.query}".`;
			if (!match) return { content: [{ type: "text" as const, text: noHits }], details: undefined };
			const limit = Math.max(1, Math.min(params.limit ?? 5, 20));
			const rows = openRecallDb()
				.prepare(
					`SELECT chat, ts, role, snippet(chunks, 4, '…', '…', '…', 16) AS snip
					 FROM chunks WHERE chunks MATCH ? ORDER BY rank LIMIT ?`,
				)
				.all(match, limit) as { chat: string; ts: string; role: string; snip: string }[];
			if (!rows.length) return { content: [{ type: "text" as const, text: noHits }], details: undefined };
			const excerpts = rows.map((r) => `[${r.chat} | ${r.ts || "?"} | ${r.role}] ${r.snip}`);
			// Summarize the hits with a one-shot turn (Hermes-style cross-session
			// recall). Fail-soft: raw excerpts are the fallback. Only when a model
			// is explicitly configured — no surprise remote calls on default
			// resolution. Delivered as this tool's result — a tool message, never
			// a system-prompt injection.
			let summary = "";
			if (config.model) {
				try {
					const { runOneShot } = await import("./session.js");
					summary = await runOneShot(
						config,
						"You summarize excerpts from past conversations. Answer only from the excerpts, citing the chat id and date for each fact. At most 5 sentences. If they don't answer the question, say so.",
						`Query: ${params.query}\n\nExcerpts from past conversations:\n${excerpts.map((e, i) => `${i + 1}. ${e}`).join("\n")}`,
						{ tools: [] },
					);
				} catch {
					// summarization is best-effort; the excerpts stand on their own
				}
			}
			const text = [
				summary && !summary.startsWith("Error:") ? `Summary:\n${summary}` : "",
				`Excerpts:\n${excerpts.join("\n\n")}`,
			]
				.filter(Boolean)
				.join("\n\n");
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	return [memory, recall];
}
