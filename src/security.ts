import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// Deny-by-default bash gate. Registers a custom tool named "bash", which
// shadows pi's built-in bash (pi's tool registry lets custom tools overwrite
// built-ins by name), so every command from any chat or schedule flows
// through one allowlist check. Matching is prefix-based per shell segment:
// the command is split on &&, ||, ;, |, and newlines and EVERY segment must
// match some "allowedCommands" pattern ("git *" = prefix, "npm test" = exact
// or prefix-with-args).
// ponytail: $(), backticks, and process substitution can still smuggle a
// second command past segment splitting; a real shell parser or running the
// gateway in a container/VM is the upgrade path (see docs/security-plan.md).
// ============================================================================

const OUTPUT_CHAR_LIMIT = 20_000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;

/** Every &&/||/;/|/newline-separated segment must match some pattern. */
export function commandAllowed(command: string, patterns: string[]): boolean {
	if (patterns.length === 0) return false;
	const segments = command
		.split(/&&|\|\||[;|\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (segments.length === 0) return false;
	return segments.every((seg) =>
		patterns.some((p) => {
			p = p.trim();
			// "git *" → prefix match; "npm test" → exact or exact-with-args
			const prefix = p.endsWith(" *") ? p.slice(0, -2).trim() : p;
			return seg === prefix || seg.startsWith(prefix + " ");
		}),
	);
}

export function bashGateTool(config: Config): ToolDefinition {
	return defineTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr, capped. " +
			"Only commands matching the user's allowlist are executed; anything else is refused. " +
			"If a command is refused, tell the user what you wanted to run and ask them to approve it with /allow <prefix>.",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})` }),
			),
		}),
		async execute(_id, { command, timeout }, signal) {
			if (!commandAllowed(command, config.allowedCommands ?? [])) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Refused: \`${command}\` is not on the command allowlist. Ask the user to approve it with /allow.`,
						},
					],
					details: undefined,
				};
			}
			const timeoutS = Math.min(Math.max(timeout ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
			try {
				const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
					cwd: process.cwd(),
					timeout: timeoutS * 1000,
					maxBuffer: 1024 * 1024,
					signal,
				});
				let text = (stdout + stderr).trim() || "(no output)";
				if (text.length > OUTPUT_CHAR_LIMIT) text = `${text.slice(0, OUTPUT_CHAR_LIMIT)}\n\n[truncated]`;
				return { content: [{ type: "text" as const, text }], details: undefined };
			} catch (err) {
				const e = err as { stdout?: string; stderr?: string; killed?: boolean; code?: number | string };
				const out = (e.stdout ?? "") + (e.stderr ?? "");
				let text = out.trim();
				if (text.length > OUTPUT_CHAR_LIMIT) text = `${text.slice(0, OUTPUT_CHAR_LIMIT)}\n\n[truncated]`;
				if (signal?.aborted) throw new Error(`${text ? text + "\n\n" : ""}Command aborted`);
				if (e.killed) throw new Error(`${text ? text + "\n\n" : ""}Command timed out after ${timeoutS} seconds`);
				throw new Error(`${text ? text + "\n\n" : ""}Command exited with code ${e.code ?? "?"}`);
			}
		},
	});
}
