// Self-check for the web fetch byte cap (issue #66): fetchpage/webSearch must
// never buffer an unbounded response body into memory or persist it to disk.
// Run: npx tsx tests/web-check.ts
import assert from "node:assert";
import { readBodyLimited, MAX_BODY_BYTES } from "../src/web.js";

const bytes = (n: number) => new Uint8Array(n).fill(0x41);

// 1. Content-Length over the cap is rejected without buffering the body
let cancelled = false;
const overLimit = {
	headers: new Headers({ "content-length": String(MAX_BODY_BYTES + 1) }),
	body: new ReadableStream({
		start(c) {
			c.enqueue(bytes(16));
			c.close();
		},
		cancel() {
			cancelled = true;
		},
	}),
} as unknown as Response;
await assert.rejects(readBodyLimited(overLimit), /too large/);
assert.ok(cancelled, "over-limit body should be cancelled, not drained");

// 2. A stream that runs past the cap mid-read is truncated (bounded buffer)
let midCanceled = false;
const oversized = {
	headers: new Headers({}),
	body: new ReadableStream({
		start(c) {
			for (let i = 0; i < 100; i++) c.enqueue(bytes(64 * 1024));
			c.close();
		},
		cancel() {
			midCanceled = true;
		},
	}),
} as unknown as Response;
const { buf, truncated } = await readBodyLimited(oversized);
assert.ok(truncated, "oversized stream should be truncated");
assert.ok(midCanceled, "truncated stream should be cancelled, not drained");
assert.ok(buf.length <= MAX_BODY_BYTES + 64 * 1024, `buffer should stay near the cap, got ${buf.length} bytes`);

// 3. Normal body under the cap comes through intact
const small = {
	headers: new Headers({ "content-length": "5" }),
	body: new ReadableStream({
		start(c) {
			c.enqueue(bytes(5));
			c.close();
		},
	}),
} as unknown as Response;
const ok = await readBodyLimited(small);
assert.strictEqual(ok.truncated, false);
assert.strictEqual(ok.buf.length, 5);
assert.strictEqual(ok.buf.toString("utf8"), "AAAAA");

// 4. Missing body yields empty output, not an error
const noBody = { headers: new Headers({}), body: null } as unknown as Response;
const empty = await readBodyLimited(noBody);
assert.strictEqual(empty.truncated, false);
assert.strictEqual(empty.buf.length, 0);

console.log("web byte-cap checks passed");