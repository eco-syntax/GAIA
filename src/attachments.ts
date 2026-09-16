/**
 * Message-attachment support: download attached files from any platform into a
 * per-chat inbox, and expose an `open_attachment` tool so the agent can read
 * their text content without the ungated built-in file tools. Text-ish files
 * (text/*, JSON, XML, CSV, code) are decoded and returned (capped like
 * fetchpage); binary files (PDFs, images, …) report their mime/size and the
 * saved path rather than pretending to be readable as text.
 *
 * Security: the tool only ever reads files under its own inbox directory
 * (<state>/attachments/<chatKey>/), never arbitrary paths, so it does not
 * reopen the read/file-access hole the chat sessions deliberately close.
 */

import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, extname, join, normalize, resolve } from "node:path";
import type { ChatAttachment, ChatRef } from "./platform.js";
import { stateDir } from "./config.js";
import { MAX_BODY_BYTES } from "./web.js";

/** Inline text cap matching fetchpage (~5K tokens at 32K context). */
const TEXT_LIMIT = 20_000;
/** Readily-decodable MIME prefixes. Anything else is treated as binary. */
const TEXT_MIME_RE = /^(text\/|application\/(json|xml|yaml|javascript|x-javascript|csv|sql|svg|rtf|ld\+json)|image\/svg\+xml)/i;
/** Extension fallback when the platform gives no MIME type. */
const TEXT_EXT = new Set([
	".txt", ".md", ".markdown", ".json", ".xml", ".yml", ".yaml", ".csv", ".tsv",
	".log", ".toml", ".ini", ".cfg", ".conf", ".sh", ".bash", ".js", ".ts", ".py",
	".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".sql", ".svg", ".html",
	".htm", ".css", ".diff", ".patch",
]);

function isTextMime(att: ChatAttachment): boolean {
	if (att.mime && TEXT_MIME_RE.test(att.mime)) return true;
	if (att.name && TEXT_EXT.has(extname(att.name).toLowerCase())) return true;
	return false;
}

/** Directory holding this chat's downloaded attachments. */
function inboxDir(ref: ChatRef): string {
	return join(stateDir, "attachments", `${ref.platform}:${ref.chatId}`);
}

/** A safe per-file name: keep the extension, drop path separators and dots. */
function safeName(name: string): string {
	const base = basename(name).replace(/\s+/g, "_");
	return base.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
}

/** Download an attachment's bytes into the chat's inbox and return the path. */
export async function saveAttachment(
	ref: ChatRef,
	att: ChatAttachment,
	platform: { getAttachment?(att: ChatAttachment): Promise<Buffer> },
): Promise<{ path: string; data: Buffer; truncated: boolean }> {
	if (!platform.getAttachment) {
		throw new Error("platform cannot fetch attachments");
	}
	const data = await platform.getAttachment(att);
	// Cap the file like fetchpage: an attacker-controlled multi-GB upload must
	// not OOM the process or fill the state disk.
	const truncated = data.length > MAX_BODY_BYTES;
	const buf = truncated ? data.subarray(0, MAX_BODY_BYTES) : data;
	const dir = inboxDir(ref);
	mkdirSync(dir, { recursive: true });
	// Keep the original filename so the agent can open it by the name it sees in
	// the listing; append -1/-2 if a previous same-named file already exists.
	const stem = safeName(att.name ?? "attachment");
	const dot = stem.lastIndexOf(".");
	const base = dot > 0 ? stem.slice(0, dot) : stem;
	const ext = dot > 0 ? stem.slice(dot) : "";
	let name = `${base}${ext}`;
	let n = 1;
	while (existsSync(join(dir, name))) {
		name = `${base}-${n++}${ext}`;
	}
	const path = join(dir, name);
	writeFileSync(path, buf, { flag: "wx" }); // never overwrite
	return { path, data: buf, truncated };
}

/** Extract readable text from a downloaded attachment (capped), or a terse
 * note explaining that binary content isn't directly readable as text. */
function extractText(att: ChatAttachment, data: Buffer): string {
	if (!isTextMime(att)) {
		const kb = Math.round(data.length / 1024);
		return `[binary attachment ${att.name ?? "file"}${att.mime ? ` (${att.mime})` : ""}: ${kb} KB of non-text bytes, not shown inline. Read it on disk or process it with a tool.]`;
	}
	const text = data.toString("utf8").replace(/\u0000/g, "").trim();
	if (!text) return "(empty file)";
	return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n\n[truncated: file is ${text.length} chars]` : text;
}

/**
 * The open_attachment tool for chat sessions. Reads a previously-downloaded
 * attachment from this chat's inbox by name. Safe: scoped to the inbox dir.
 */
export function attachmentTool(ref: ChatRef): ToolDefinition {
	const dir = inboxDir(ref);
	const describe = () => {
		if (!existsSync(dir)) return "(none)";
		return (readdirSync(dir) as string[])
			.map((f) => {
				try {
					return `- ${f} (${statSync(join(dir, f)).size} bytes)`;
				} catch {
					return `- ${f}`;
				}
			})
			.join("\n");
	};
	return defineTool({
		name: "open_attachment",
		label: "Open attachment",
		description:
			"Read the text content of a file the user attached to this chat (documents, configs, logs, code). Attachment files live in this chat's attachment inbox. List available attachments by passing 'list'. Returns the file's text (capped); binary files (PDFs, images) report their mime/size instead since their bytes aren't readable as text here.",
		parameters: Type.Object({
			name: Type.String({ description: "Inbox filename to open, or \"list\" for the available attachments." }),
		}),
		async execute(_id, params) {
			if (params.name.trim().toLowerCase() === "list") {
				return {
					content: [
						{
							type: "text" as const,
							text: `Attachments on disk:\n${describe() || "(none yet)"}`,
						},
					],
					details: undefined,
				};
			}
			// Resolve strictly inside the inbox: never follow ../ out of it.
			const target = resolve(dir, normalize(params.name));
			const base = resolve(dir);
			if (target !== base && !target.startsWith(base + "/")) {
				return { content: [{ type: "text" as const, text: `Refusing to open ${params.name}: outside the attachment inbox.` }], details: undefined };
			}
			if (!existsSync(target) || !statSync(target).isFile()) {
				return { content: [{ type: "text" as const, text: `No such attachment "${params.name}". List them with open_attachment list.` }], details: undefined };
			}
			const data = readFileSync(target);
			const att: ChatAttachment = { id: "", name: basename(target), mime: guessMime(basename(target)) };
			return { content: [{ type: "text" as const, text: extractText(att, data) }], details: undefined };
		},
	});
}

function guessMime(name: string): string | undefined {
	const ext = extname(name).toLowerCase();
	const map: Record<string, string> = {
		".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
		".xml": "application/xml", ".csv": "text/csv", ".yml": "text/yaml",
		".yaml": "text/yaml", ".log": "text/plain", ".sh": "text/x-shellscript",
		".py": "text/x-python", ".js": "text/javascript", ".ts": "text/x-typescript",
		".html": "text/html", ".htm": "text/html", ".css": "text/css",
		".svg": "image/svg+xml", ".pdf": "application/pdf", ".png": "image/png",
		".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	};
	return map[ext];
}