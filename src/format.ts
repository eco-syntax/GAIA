/**
 * Convert model markdown to Telegram HTML so formatting renders instead of
 * leaking as literal asterisks. Order matters: code blocks are pulled out
 * first, the rest is HTML-escaped before inline transforms.
 */

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function toTelegramHtml(markdown: string): string {
	// 1. Pull out fenced code blocks.
	const blocks: string[] = [];
	let text = markdown.replace(/```[a-z]*\n?([\s\S]*?)```/g, (_m, code: string) => {
		blocks.push(`<pre>${escapeHtml(code.trimEnd())}</pre>`);
		return `\u0000BLOCK${blocks.length - 1}\u0000`;
	});

	// 2. Escape the remainder.
	text = escapeHtml(text);

	// 3. Inline transforms.
	text = text
		.replace(/`([^`\n]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
		.replace(/(^|\s)\*([^*\n]+)\*/g, "$1<i>$2</i>")
		.replace(/(^|\s)_([^_\n]+)_/g, "$1<i>$2</i>")
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
		.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
		.replace(/^\s*[-*]\s+/gm, "• ")
		.replace(/^\s*&gt;\s+/gm, "❝ ");

	// 4. Restore code blocks.
	text = text.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)] ?? "");

	return text.trim();
}

/**
 * Drop reasoning sections that leak into text blocks. Proper reasoning arrives
 * as "thinking" content blocks (turnOutcome already filters those out of the
 * reply), but some models/providers emit the chain of thought inline wrapped
 * in <thinking> tags — strip those so a reply never reads its own reasoning
 * aloud.
 */
export function stripReasoning(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ");
}

/**
 * Convert model markdown to plain prose for TTS. Voice notes must not read the
 * markdown syntax aloud ("asterisk asterisk bold asterisk asterisk") and must
 * not speak reasoning steps that a text chat response excludes. Fenced code
 * blocks keep their content (only the fences are dropped) so a code-heavy
 * reply still says something; <thinking> sections are dropped entirely.
 */
export function toSpokenText(markdown: string): string {
	// 1. Reasoning first, before inline transforms can mangle the tags.
	let text = stripReasoning(markdown);

	// 2. Pull out fenced code blocks, keeping only the code itself.
	text = text.replace(/```[a-z]*\n?([\s\S]*?)```/g, (_m, code: string) => code.trim());

	// 3. Inline markdown → plain prose.
	text = text
		.replace(/`([^`\n]+)`/g, "$1")
		.replace(/\*\*([^*\n]+)\*\*/g, "$1")
		.replace(/(^|\s)\*([^*\n]+)\*/g, "$1$2")
		.replace(/(^|\s)_([^_\n]+)_/g, "$1$2")
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
		.replace(/^#{1,6}\s+(.+)$/gm, "$1")
		.replace(/^\s*[-*]\s+/gm, "")
		.replace(/^\s*\d+[.)]\s+/gm, "")
		.replace(/^\s*(?:&gt;|>)\s+/gm, "")
		.replace(/^\s*([-*_])\1{2,}\s*$/gm, "");

	// 4. Trim each line, then collapse blank runs.
	text = text
		.split("\n")
		.map((line) => line.trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return text;
}
