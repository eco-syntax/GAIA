// Self-check for reply-URL verification: URLs the model actually saw (user
// messages, tool calls, tool results) survive; invented URLs are stripped.
// Run: npx tsx tests/url-check.ts
import assert from "node:assert";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { verifyReplyUrls } from "../src/session.js";

// A session-shaped fixture: user shared a URL, model fetched a bare origin,
// tool returned page text.
const session = {
	messages: [
		{ role: "user", content: "Check https://example.com/start please", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "1", name: "fetchpage", arguments: { url: "https://example.com" } },
			],
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "1",
			toolName: "fetchpage",
			isError: false,
			content: [{ type: "text", text: "Example Domain" }],
			timestamp: 3,
		},
	],
} as unknown as AgentSession;

const reply =
	"Population is 8.4M.\nhttps://example.com\nhttps://example.com/start\nhttps://en.wikipedia.org/wiki/New_York_City\nhttps://invented.example/fake";
const out = verifyReplyUrls(session, reply);

// Origin match: the fetchpage call saw https://example.com.
assert.ok(out.includes("https://example.com\n"), "seen origin passes");
// Exact match: the user's own message carried the full URL.
assert.ok(out.includes("https://example.com/start"), "user-shared URL passes");
// Unseen exact URLs — wikipedia page and an invented host — are stripped.
assert.ok(!out.includes("en.wikipedia.org"), "unseen URL removed");
assert.ok(!out.includes("invented.example"), "invented URL removed");
assert.equal(out.match(/\[unverified link removed\]/g)?.length, 2, "both fakes became placeholders");

console.log("url-check: all assertions passed");