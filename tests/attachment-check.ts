// Self-check for the message-attachment support (issue #108): the agent must be
// able to download an attached file and read its text via open_attachment, and
// must not be able to read files outside its own inbox.
// Run: npx tsx tests/attachment-check.ts
import assert from "node:assert";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the gateway state at a temp dir BEFORE importing src (stateDir is
// computed from this env at import time).
const stateHome = mkdtempSync(join(tmpdir(), "attach-check-"));
process.env.GAIA_STATE = join(stateHome, ".gaia");

const { saveAttachment, attachmentTool } = await import("../src/attachments.js");
import type { ChatAttachment, ChatRef } from "../src/platform.js";

const ref: ChatRef = { platform: "telegram", chatId: "123" };
const stubPlatform = {
	async getAttachment(att: ChatAttachment): Promise<Buffer> {
		return Buffer.from(att.id === "cfg" ? "greeting=hello\nmode=enabled\n" : "a%PDF-1.4 fake binary \u0000\u0001\u0002");
	},
};

// 1. A text attachment downloads into the inbox and is readable via the tool.
// Reading an attachment is reading untrusted content, so the tool must taint
// the session (same contract as webTools / bashGateTool / taintOnRead).
const text = await saveAttachment(ref, { id: "cfg", name: "service.conf", mime: "text/plain" }, stubPlatform);
assert.ok(existsSync(text.path), "text attachment should be saved to the inbox");
let tainted = false;
const tool = attachmentTool(ref, () => {
	tainted = true;
});
const opened = await tool.execute("t", { name: "service.conf" });
assert.match(opened.content[0].text, /greeting=hello/, "tool should return the file's text");
assert.match(opened.content[0].text, /mode=enabled/, "tool should return the whole text content");
assert.ok(tainted, "open_attachment must taint the session on any read");

// 2. 'list' enumerates the inbox (and also taints: filenames are untrusted too).
const list = await tool.execute("t", { name: "list" });
assert.match(list.content[0].text, /service\.conf/, "list should show the downloaded file");
assert.ok(tainted, "list must taint too");

// 3. A binary attachment (PDF) is saved but not misreported as readable text.
const pdf = await saveAttachment(ref, { id: "pdf", name: "report.pdf", mime: "application/pdf" }, stubPlatform);
assert.ok(existsSync(pdf.path), "binary attachment should be saved");
const pdfRead = await tool.execute("t", { name: "report.pdf" });
assert.match(pdfRead.content[0].text, /binary attachment/, "binary files should report as binary, not fake text");

// 4. Path traversal must not escape the inbox. Try a deep traversal to an
// existing real file — the tool must refuse, never read it.
const escape = await tool.execute("t", { name: "../../../../../../../../etc/passwd" });
assert.ok(
	/Refusing/.test(escape.content[0].text) || /No such attachment/.test(escape.content[0].text),
	`path traversal must be refused or not found, got: ${escape.content[0].text}`,
);
assert.ok(!/^root:/m.test(escape.content[0].text), "traversal must not return external file content");

// 5. Missing file returns a clear message.
const missing = await tool.execute("t", { name: "nope.txt" });
assert.match(missing.content[0].text, /No such attachment/, "missing file should be reported");

rmSync(stateHome, { recursive: true, force: true });
console.log("attachment self-checks passed");