// Self-check for the reply-formatting helpers in src/format.ts: TTS text must
// not read markdown syntax aloud or speak reasoning steps (issue #91).
// Run: npx tsx tests/format-check.ts
import { toSpokenText, stripReasoning, toTelegramHtml } from "../src/format.js";

let failures = 0;
function check(cond: boolean, msg: string, extra?: unknown): void {
	if (cond) return;
	failures++;
	console.error(msg, extra ?? "");
}

// ---- markdown syntax must not be spoken ------------------------------------
check(toSpokenText("**bold** text") === "bold text", "FAIL: bold markers spoken", toSpokenText("**bold** text"));
check(toSpokenText("_italic_ and *italic*") === "italic and italic", "FAIL: italic markers spoken", toSpokenText("_italic_ and *italic*"));
check(toSpokenText("use `git status`") === "use git status", "FAIL: inline code backticks spoken", toSpokenText("use `git status`"));
check(toSpokenText("# Heading") === "Heading", "FAIL: heading hash spoken", toSpokenText("# Heading"));
check(toSpokenText("- one\n- two") === "one\ntwo", "FAIL: list bullets spoken", toSpokenText("- one\n- two"));
check(toSpokenText("1. first\n2. second") === "first\nsecond", "FAIL: numbered list markers spoken", toSpokenText("1. first\n2. second"));
check(toSpokenText("> quoted") === "quoted", "FAIL: blockquote marker spoken", toSpokenText("> quoted"));
check(toSpokenText("[see docs](https://example.com)") === "see docs", "FAIL: link syntax spoken", toSpokenText("[see docs](https://example.com)"));
check(toSpokenText("plain prose") === "plain prose", "FAIL: plain prose mangled", toSpokenText("plain prose"));

// ---- fenced code blocks keep content, drop fences ---------------------------
check(
	toSpokenText("Run:\n```bash\ngit status\n```") === "Run:\ngit status",
	"FAIL: code fences spoken or content dropped",
	toSpokenText("Run:\n```bash\ngit status\n```"),
);

// ---- reasoning must not be spoken -------------------------------------------
check(
	toSpokenText("<thinking>The user wants git help.</thinking>Run git status.") === "Run git status.",
	"FAIL: <thinking> reasoning spoken",
	toSpokenText("<thinking>The user wants git help.</thinking>Run git status."),
);
check(
	toSpokenText("<thinking>step one</thinking>answer<thinking>step two</thinking>") === "answer",
	"FAIL: multiple reasoning sections spoken",
	toSpokenText("<thinking>step one</thinking>answer<thinking>step two</thinking>"),
);

// ---- stripReasoning is case-insensitive and leaves prose intact -------------
check(stripReasoning("<thinking>hidden</thinking>shown") === " shown", "FAIL: stripReasoning", stripReasoning("<thinking>hidden</thinking>shown"));
check(stripReasoning("<THINKING>hidden</THINKING>shown") === " shown", "FAIL: stripReasoning case", stripReasoning("<THINKING>hidden</THINKING>shown"));
check(stripReasoning("no tags here") === "no tags here", "FAIL: stripReasoning altered prose", stripReasoning("no tags here"));

// ---- toTelegramHtml still renders markdown for text messages ----------------
check(toTelegramHtml("**bold**") === "<b>bold</b>", "FAIL: toTelegramHtml regression", toTelegramHtml("**bold**"));
check(toTelegramHtml("use `git status`") === "use <code>git status</code>", "FAIL: toTelegramHtml regression 2", toTelegramHtml("use `git status`"));

if (failures) {
	console.error(`format-check FAILED (${failures} check(s))`);
	process.exit(1);
}
console.log("format-check OK");