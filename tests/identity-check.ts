// Runnable check for identity linking (/link code flow): npx tsx tests/identity-check.ts.
// Self-contained: points HOME at a temp dir BEFORE importing src, so it never
// touches real state (stateDir is computed from homedir() at import time).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "identity-check-"));
process.env.HOME = home;
const { createPendingLink, consumeLink, identityForChat, whoami, recallChatScope } = await import("../src/identity.js");
import type { ChatMessage } from "../src/platform.js";

let failures = 0;
function check(cond: boolean, msg: string, extra?: unknown): void {
	if (cond) return;
	failures++;
	console.error(msg, extra ?? "");
}

const dm = (platform: string, chatId: string, userId = "userA"): ChatMessage => ({
	ref: { platform, chatId },
	userId,
	userName: "Alice",
	direct: true,
});

const tgA = dm("telegram", "111");
const tgB = dm("telegram", "222");
const disc = dm("discord", "999");

// 1. fresh chats have no identity; whoami says so
check(identityForChat(tgA.ref) === undefined, "FAIL: fresh chats have no identity");
check(whoami(tgA.ref).includes("Not linked"), "FAIL: whoami on unlinked chat", whoami(tgA.ref));

// 2. link flow: code generated in A, redeemed in B → same identity
const code = createPendingLink(tgA);
check(code.length === 6 && /^[A-Z2-9]{6}$/.test(code), "FAIL: code shape", code);
const res = consumeLink(code, tgB);
check(res.ok, "FAIL: consumeLink should succeed", res);
const idA = identityForChat(tgA.ref);
check(idA !== undefined && idA.id === identityForChat(tgB.ref)?.id, "FAIL: chats must share an identity");

// 3. single-use: redeeming the same code fails
const again = consumeLink(code, tgB);
check(!again.ok, "FAIL: code must be single-use", again);

// 4. cross-platform: a new code from tgA links discord into the same identity
const res2 = consumeLink(createPendingLink(tgA), disc);
check(res2.ok && res2.uid === identityForChat(tgA.ref)?.id, "FAIL: discord should join identity", res2);

// 5. recall scope covers all linked chats (namespaced + legacy bare ids)
const scope = recallChatScope(tgA.ref);
check(
	scope.includes("telegram:111") && scope.includes("telegram:222") && scope.includes("discord:999") && scope.includes("222"),
	"FAIL: recall scope should cover linked chats",
	scope,
);

// 6. an unrelated user linking their own chats stays in a separate identity
const outsider = dm("matrix", "!room:server", "mallory");
const res3 = consumeLink(createPendingLink(outsider), dm("matrix", "!other:server", "mallory"));
check(res3.ok, "FAIL: outsider linking", res3);
check(identityForChat(tgA.ref)!.id !== identityForChat(outsider.ref)!.id, "FAIL: identities must stay separate");
check(!recallChatScope(tgA.ref).includes("matrix:!room:server"), "FAIL: outsider leaked into scope");

// 7. redeeming a code in the chat that generated it is refused
const res4 = consumeLink(createPendingLink(tgA), tgA);
check(!res4.ok, "FAIL: same-chat redeem must fail", res4);

// 8. merging two established identities is refused (memory-leak guard)
const otherA = dm("slack", "D1", "mallory");
const otherB = dm("slack", "D2", "mallory");
const okOther = consumeLink(createPendingLink(otherA), otherB);
check(okOther.ok, "FAIL: setup other identity", okOther);
const merge = consumeLink(createPendingLink(tgA), otherA);
check(!merge.ok, "FAIL: merging established identities must be refused", merge);

// 9. whoami lists linked chats after linking
const w = whoami(tgA.ref);
check(w.includes("telegram chat 111") && w.includes("discord chat 999"), "FAIL: whoami should list linked chats", w);

rmSync(home, { recursive: true, force: true });
if (failures) {
	console.error(`identity-check FAILED (${failures} check(s))`);
	process.exit(1);
}
console.log("identity-check OK");