// Runnable check for the FTS5 recall index: npx tsx tests/recall-check.ts.
// Self-contained: points HOME at a temp dir BEFORE importing src, so it never
// touches real state (stateDir is computed from homedir() at import time).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "recall-check-"));
process.env.HOME = home;
const { memoryTools } = await import("../src/memory.js");
import type { Config } from "../src/config.js";
const sessions = join(home, ".pi-gateway", "sessions");
const log = (role: string, text: string) =>
	JSON.stringify({ type: "message", timestamp: "2026-09-11T12:00:00Z", message: { role, content: [{ type: "text", text }] } });
mkdirSync(join(sessions, "111"), { recursive: true });
mkdirSync(join(sessions, "222"), { recursive: true });
writeFileSync(join(sessions, "111", "a.jsonl"), `${log("user", "We chose SQLite FTS5 for the drone telemetry pipeline")}\n${log("assistant", "Noted — telemetry pipeline uses SQLite FTS5")}\n`);
writeFileSync(join(sessions, "222", "b.jsonl"), `${log("user", "The greenhouse watering schedule runs at dawn")}\n`);

const config = {} as Config;
const recall = memoryTools(config).find((t) => t.name === "recall")!;
const run = (query: string) => recall.execute("t", { query }).then((r: any) => r.content[0].text);

// 1. basic hit across chats
const basic = await run("FTS5 telemetry");
console.assert(basic.includes("111"), "FAIL: expected chat 111 hit", basic);
console.assert(basic.includes("Excerpts:"), "FAIL: expected excerpts section", basic);

// 2. second chat indexed, AND semantics: both terms required
const both = await run("greenhouse dawn");
console.assert(both.includes("222"), "FAIL: expected chat 222 hit", both);

// 3. FTS5 syntax injection is neutralized
const evil = await run('"telemetry" OR (drop)');
console.assert(typeof evil === "string", "FAIL: injected query crashed");

// 4. no match
const none = await run("zzzunmatchable");
console.assert(none.startsWith("No matches"), "FAIL: expected no-match message", none);

// 5. incremental: append a line, re-index picks it up without a full rebuild
const f = join(sessions, "111", "a.jsonl");
const before = await run("hydroponics");
console.assert(before.startsWith("No matches"), "FAIL: hydroponics should not exist yet", before);
writeFileSync(f, `${log("user", "We chose SQLite FTS5 for the drone telemetry pipeline")}\n${log("user", "later we moved hydroponics sensors to MQTT")}\n`);
const after = await run("hydroponics");
console.assert(after.includes("111"), "FAIL: incremental re-index missed appended line", after);

// 6. shrunk file (rewrite) is re-indexed, not double-indexed
writeFileSync(f, `${log("user", "only this line remains about FTS5")}\n`);
const shrunk = await run("hydroponics");
console.assert(shrunk.startsWith("No matches"), "FAIL: deleted line still indexed", shrunk);
const kept = await run("remains");
console.assert(kept.includes("111"), "FAIL: surviving line lost after rewrite", kept);

// 7. deleted log disappears from the index
const { rmSync } = await import("node:fs");
rmSync(join(sessions, "222"), { recursive: true });
const gone = await run("greenhouse");
console.assert(gone.startsWith("No matches"), "FAIL: deleted chat still indexed", gone);

console.log("recall-check OK");
rmSync(home, { recursive: true, force: true });
