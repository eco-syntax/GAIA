import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

// ============================================================================
// Deny-by-default bash gate. Registers a custom tool named "bash", which
// shadows pi's built-in bash (pi's tool registry lets custom tools overwrite
// built-ins by name), so every command from any chat or schedule flows
// through one gate we own.
//
// There is NO command allowlist. The old prefix allowlist was unsound: any
// allowlisted binary that can spawn a subprocess (git -c alias.pwn=!id,
// find . -exec sh -c id, npm test --prefix /tmp/evil, node -e, ...) granted
// arbitrary command execution, so a prompt-injected model could run anything.
// Real containment must come from the OS sandbox (container/VM/systemd
// hardening — see docs/security-plan.md), not from matching strings against
// programs that can themselves exec.
//
// Instead, every bash command is gated behind user approval:
//   - By default the gate is CLOSED: the tool refuses any command and tells
//     the model to ask the user.
//   - The user approves bash for a chat with /bash (an explicit, single
//     human-in-the-loop decision), which shows a security warning.
//   - The gate resets to CLOSED whenever a new session starts.
// This mirrors how most agentic harnesses handle shell access. The gate's job
// is the approval prompt, not a shell parser.
// ============================================================================

const OUTPUT_CHAR_LIMIT = 20_000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;

/** Headless one-shot sessions (scheduled tasks) have no user present to
 * approve a command, so their bash tool must always stay closed. This is a
 * namespaced sentinel that can never collide with a real chat key
 * ("platform:chatId"). */
export const NO_CHAT = "__no_chat__";

/**
 * Per-chat bash gate. A chat is CLOSED (blocked) by default; the user must
 * explicitly approve bash for the session with /bash. Approvals never leak
 * across a new session.
 */
export class BashGate {
	private approved = new Map<string, boolean>();

	/** True when bash is blocked and every command must be refused. */
	blocked(chatId: string): boolean {
		return chatId === NO_CHAT || !this.approved.get(chatId);
	}

	/** Approve bash for a chat (turns off per-command approval). */
	allow(chatId: string): void {
		// NO_CHAT has no user to approve, so it can never be opened.
		if (chatId !== NO_CHAT) this.approved.set(chatId, true);
	}

	/** Put a chat back to the default closed state. */
	block(chatId: string): void {
		this.approved.set(chatId, false);
	}

	/** Drop the decision so the NEXT session for this chat starts closed again. */
	reset(chatId: string): void {
		this.approved.delete(chatId);
	}
}

/** Shared gate, keyed by namespaced chat key ("platform:chatId"). */
export const bashGate = new BashGate();

export function bashGateTool(chatId: string): ToolDefinition {
	return defineTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr, capped. " +
			"Bash is gated: by default every command is refused and you must ask the user to approve " +
			"bash for this session with /bash. If a command is refused, tell the user exactly what " +
			"you wanted to run and ask them to run /bash.",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})` }),
			),
		}),
		async execute(_id, { command, timeout }, signal) {
			if (bashGate.blocked(chatId)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Refused: bash is locked in this session, so \`${command}\` was not run. Every bash command needs user approval here. Ask the user to run /bash to approve bash for this session (it shows a security warning first).`,
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