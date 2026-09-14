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
