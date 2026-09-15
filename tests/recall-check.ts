// Runnable check for the FTS5 recall index + identity scoping: npx tsx tests/recall-check.ts.
// Self-contained: points HOME at a temp dir BEFORE importing src, so it never
// touches real state (stateDir is computed from homedir() at import time).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "recall-check-"));
process.env.HOME = home;
const { memoryTools } = await import("../src/memory.js");
const { createPendingLink, consumeLink } = await import("../src/identity.js");
import type { Config } from "../src/config.js";
const sessions = join(home, ".pi-gateway", "sessions");
const log = (role: string, text: string) =>
	JSON.stringify({ type: "message", timestamp: "2026-09-11T12:00:00Z", message: { role, content: [{ type: "text", text }] } });
mkdirSync(join(sessions, "111"), { recursive: true });
mkdirSync(join(sessions, "222"), { recursive: true });
mkdirSync(join(sessions, "333"), { recursive: true });
writeFileSync(join(sessions, "111", "a.jsonl"), `${log("user", "We chose SQLite FTS5 for the drone telemetry pipeline")}\n${log("assistant", "Noted — telemetry pipeline uses SQLite FTS5")}\n`);
writeFileSync(join(sessions, "222", "b.jsonl"), `${log("user", "The greenhouse watering schedule runs at dawn")}\n`);
writeFileSync(join(sessions, "333", "c.jsonl"), `${log("user", "greenhouse plants need more nitrogen")}\n`);

const config = {} as Config;
const dm = (chatId: string) => ({
	ref: { platform: "telegram", chatId },
	userId: "1",
	userName: "alice",
	direct: true,
});
// Link chats 111 and 222 into one identity: code generated in 111, redeemed in 222.
const code = createPendingLink(dm("111"));
if (!consumeLink(code, dm("222")).ok) throw new Error("setup: linking 111 and 222 failed");
const recall111 = memoryTools(config, () => false, { platform: "telegram", chatId: "111" }).find((t) => t.name === "recall")!;
const recall333 = memoryTools(config, () => false, { platform: "telegram", chatId: "333" }).find((t) => t.name === "recall")!;
const run = (tool: { execute: (id: string, p: { query: string }) => Promise<any> }, query: string) =>
	tool.execute("t", { query }).then((r: any) => r.content[0].text);

// console.assert only prints; collect failures and exit non-zero so a
// regression in the FTS index actually fails the check.
let failures = 0;
function check(cond: boolean, msg: string, extra?: unknown): void {
	if (cond) return;
	failures++;
	console.error(msg, extra ?? "");
}

// 1. basic hit in the calling chat (linked scope includes 111 + 222)
const basic = await run(recall111, "FTS5 telemetry");
check(basic.includes("111"), "FAIL: expected chat 111 hit", basic);
check(basic.includes("Excerpts:"), "FAIL: expected excerpts section", basic);

// 2. identity scope: a recall from 111 finds 222's logs too
const linked = await run(recall111, "greenhouse dawn");
check(linked.includes("222"), "FAIL: expected linked chat 222 hit", linked);

// 3. unlinked chat 333 only sees its own logs — NOT the linked pair's
const outsider = await run(recall333, "greenhouse");
check(outsider.includes("333"), "FAIL: expected chat 333 hit", outsider);
const leak = await run(recall333, "FTS5");
check(leak.startsWith("No matches"), "FAIL: unlinked chat must not see other chats", leak);

// 4. FTS5 syntax injection is neutralized
const evil = await run(recall111, '"telemetry" OR (drop)');
check(typeof evil === "string", "FAIL: injected query crashed");

// 5. no match
const none = await run(recall111, "zzzunmatchable");
check(none.startsWith("No matches"), "FAIL: expected no-match message", none);

// 6. incremental: append a line, re-index picks it up without a full rebuild
const f = join(sessions, "111", "a.jsonl");
const before = await run(recall111, "hydroponics");
check(before.startsWith("No matches"), "FAIL: hydroponics should not exist yet", before);
writeFileSync(f, `${log("user", "We chose SQLite FTS5 for the drone telemetry pipeline")}\n${log("user", "later we moved hydroponics sensors to MQTT")}\n`);
const after = await run(recall111, "hydroponics");
check(after.includes("111"), "FAIL: incremental re-index missed appended line", after);

// 7. shrunk file (rewrite) is re-indexed, not double-indexed
writeFileSync(f, `${log("user", "only this line remains about FTS5")}\n`);
const shrunk = await run(recall111, "hydroponics");
check(shrunk.startsWith("No matches"), "FAIL: deleted line still indexed", shrunk);
const kept = await run(recall111, "remains");
check(kept.includes("111"), "FAIL: surviving line lost after rewrite", kept);

// 8. deleted log disappears from the index (even when it's in the linked scope)
rmSync(join(sessions, "222"), { recursive: true });
const gone = await run(recall111, "greenhouse");
check(gone.startsWith("No matches"), "FAIL: deleted chat still indexed", gone);

rmSync(home, { recursive: true, force: true });
if (failures) {
	console.error(`recall-check FAILED (${failures} check(s))`);
	process.exit(1);
}
console.log("recall-check OK");