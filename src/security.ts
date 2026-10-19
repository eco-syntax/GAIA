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

// Secret redaction: the agent's own credentials (bot tokens, model API keys)
// are the one thing a filesystem sandbox cannot hide from it — the process
// needs them to work, and they live in its environment. A prompt-injected
// model can run `printenv` or `cat /proc/self/environ` and relay the values
// into a chat reply or a websearch query (a search POSTs its query text to an
// external server). Every tool that returns untrusted-through-the-agent data
// runs its output through redactSecrets: any environment value that looks
// like a credential (name matches TOKEN/KEY/SECRET/PASSWORD, value ≥ 12
// chars) is replaced wherever it appears. This stops the direct dump; an
// obfuscated exfiltration (base64-encode then decode remotely) is the
// container boundary's job, not this filter's.
const SECRET_VALUES = Object.entries(process.env)
	.filter(([name, value]) => /TOKEN|KEY|SECRET|PASSWORD|PAT\b/i.test(name) && (value?.length ?? 0) >= 12)
	.map(([, value]) => value!);

/** Replace known secret values in tool output. Exported for tests. */
export function redactSecrets(text: string): string {
	let out = text;
	for (const secret of SECRET_VALUES) {
		// Split/join instead of replace: replace would treat $-patterns in
		// tokens (Telegram tokens contain none, but API keys might) as regex.
		while (out.includes(secret)) out = out.split(secret).join("[redacted]");
	}
	return out;
}

/** Headless one-shot sessions (scheduled tasks) have no user present to
 * approve a command, so their bash tool must always stay closed. This is a
 * namespaced sentinel that can never collide with a real chat key
 * ("platform:chatId"). */
export const NO_CHAT = "__no_chat__";

/** Destructive-command patterns for the friction tier. High-blast-radius,
 * hard-to-reverse commands a model might reach for blindly. This is NOT a
 * denylist (see docs/security-plan.md): a flagged command still runs after
 * /bash force, so the property is "second approval for footguns," not
 * "blocked forever."
 *
 * ponytail: classification is regex over the raw command string. It catches
 * the obvious footguns (rm -r, sudo, mkfs, git push --force, curl|sh) and
 * misses anything obfuscated (base64 decode, env-var payload, alias chains,
 * combined short flags like -fv). That is acceptable because the binary gate
 * stays closed-by-default and the systemd sandbox is the real boundary — this
 * tier is friction, not a security control. Do NOT let it weaken the gate
 * later ("we classify destructive, so auto-approve the rest"): that turns it
 * back into the unsound allowlist the gate replaced. */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/(?<!\bgit )\brm\b[^|;&<>()]*(-\w*[rR]|--recursive)/, // rm -r, rm -rf, rm --recursive (skips git rm)
	/\bdd\b[^|;&<>()]*of=\/dev\//, // dd to a block device
	/\b(mkfs\w*|shred)\b/, // format / secure-overwrite
	/\bgit\s+push\b[^|;&]*(--force(?![\w-])|\s-f(?![\w-]))/, // force push (skips --force-with-lease)
	/>\s*\/dev\/(sd|nvme|disk|mmcblk)/, // redirect to a raw device
	/\bsudo\b/, // privilege escalation (also blocked by NoNewPrivileges)
	/\b(shutdown|reboot|halt|poweroff)\b/, // system power
	/\bchmod\b[^|;&]*\b777\b/, // world-writable
	/\bchown\b[^|;&]*\s-R\b/, // recursive chown
	/\b(curl|wget)\b[^|;]*\|\s*(sh|bash)\b/, // pipe-to-shell (remote code exec)
];

/** True if a command looks high-blast-radius enough to warrant a second
 * confirmation after /bash has already opened the gate. Exported for tests. */
export function isDestructive(command: string): boolean {
	return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}

/**
 * Per-chat bash gate with two approval levels plus a one-shot destructive
 * bypass. A chat is CLOSED (blocked) by default; the user must explicitly
 * approve bash for the session with /bash.
 *
 *   closed   — every command refused (default).
 *   open     — /bash: non-destructive commands run; destructive ones are
 *              refused until the user re-confirms with /bash force.
 *   trusted  — /act or /delegate: the invocation is the human sign-off for
 *              shell work including destructive steps, so the friction tier
 *              is skipped.
 *
 * /bash force sets a one-shot: the next destructive command the model runs
 * bypasses the friction tier, then the flag is consumed. Approvals never
 * leak across a new session.
 */
export class BashGate {
	private approved = new Map<string, "open" | "trusted">();
	private force = new Set<string>();

	/** True when bash is closed: every command is refused (default state). */
	blocked(chatId: string): boolean {
		return chatId === NO_CHAT || !this.approved.has(chatId);
	}

	/** True when the chat is fully approved and destructive commands skip the
	 * friction tier (/act, /delegate). */
	trusted(chatId: string): boolean {
		return this.approved.get(chatId) === "trusted";
	}

	/** Approve bash for non-destructive commands; destructive ones need
	 * /bash force. Clears any stale one-shot. */
	allow(chatId: string): void {
		// NO_CHAT has no user to approve, so it can never be opened.
		if (chatId === NO_CHAT) return;
		this.approved.set(chatId, "open");
		this.force.delete(chatId);
	}

	/** Approve bash for ALL commands including destructive (/act, /delegate). */
	trust(chatId: string): void {
		if (chatId === NO_CHAT) return;
		this.approved.set(chatId, "trusted");
		this.force.delete(chatId);
	}

	/** One-shot: let the next destructive command bypass the friction tier. */
	forceNext(chatId: string): void {
		if (chatId === NO_CHAT) return;
		this.force.add(chatId);
	}

	/** Consume and return whether a one-shot force was pending for this chat.
	 * Called only from the destructive-check path, so a force set but never
	 * matched by a destructive command persists until /new or /bash off clears
	 * it — ponytail: that degrades to today's /bash-approved behavior (no
	 * friction tier), not worse, since the binary gate is still the control. */
	consumeForce(chatId: string): boolean {
		const has = this.force.has(chatId);
		this.force.delete(chatId);
		return has;
	}

	/** Put a chat back to the default closed state. */
	block(chatId: string): void {
		this.approved.delete(chatId);
		this.force.delete(chatId);
	}

	/** Drop the decision so the NEXT session for this chat starts closed again. */
	reset(chatId: string): void {
		this.approved.delete(chatId);
		this.force.delete(chatId);
	}
}

/** Shared gate, keyed by namespaced chat key ("platform:chatId"). */
export const bashGate = new BashGate();

/** @param chatId namespaced chat key ("platform:chatId").
 * @param onAccess called once a command actually executes (after the gate
 * passes), so callers can taint the session — command output (gh, git, ...)
 * is untrusted data, never instructions. Refused commands must NOT taint. */
export function bashGateTool(chatId: string, onAccess?: () => void): ToolDefinition {
	return defineTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr, capped. " +
			"Bash is gated: by default every command is refused and you must ask the user to approve " +
			"bash for this session with /bash. If a command is refused, tell the user exactly what " +
			"you wanted to run and ask them to run /bash. Even after bash is approved, high-blast-radius " +
			"commands (rm -r, sudo, mkfs, git push --force, curl|sh, etc.) are refused once more; tell " +
			"the user what you want to run and they can approve that one command with /bash force.",
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
			// Friction tier (not a denylist — see docs/security-plan.md): even
			// after /bash opens the gate, high-blast-radius commands are refused
			// once and the model is told to ask the user to re-confirm with
			// /bash force (a one-shot) or run the command themselves. /act and
			// /delegate set "trusted" and skip this entirely. A refused
			// destructive command runs nothing and must NOT taint the session.
			if (!bashGate.trusted(chatId) && isDestructive(command) && !bashGate.consumeForce(chatId)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Refused (destructive): \`${command}\` looks high-blast-radius (rm -r, sudo, mkfs, git push --force, curl|sh, …) and was not run even though bash is approved. Tell the user exactly what you wanted to run and why; they can approve this one command with /bash force, or run it themselves.`,
						},
					],
					details: undefined,
				};
			}
			onAccess?.(); // command output (gh, git, ...) is untrusted — taint the session
			const timeoutS = Math.min(Math.max(timeout ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
			try {
				const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
					// Sandboxed runs aim the agent at its workspace, not the repo it
					// was launched from (GAIA_WORKSPACE is set by the sandbox/compose).
					cwd: process.env.GAIA_WORKSPACE ?? process.cwd(),
					timeout: timeoutS * 1000,
					maxBuffer: 1024 * 1024,
					signal,
				});
				let text = redactSecrets((stdout + stderr).trim()) || "(no output)";
				if (text.length > OUTPUT_CHAR_LIMIT) text = `${text.slice(0, OUTPUT_CHAR_LIMIT)}\n\n[truncated]`;
				return { content: [{ type: "text" as const, text }], details: undefined };
			} catch (err) {
				const e = err as { stdout?: string; stderr?: string; killed?: boolean; code?: number | string };
				let text = redactSecrets((e.stdout ?? "") + (e.stderr ?? "")).trim();
				if (text.length > OUTPUT_CHAR_LIMIT) text = `${text.slice(0, OUTPUT_CHAR_LIMIT)}\n\n[truncated]`;
				if (signal?.aborted) throw new Error(`${text ? text + "\n\n" : ""}Command aborted`);
				if (e.killed) throw new Error(`${text ? text + "\n\n" : ""}Command timed out after ${timeoutS} seconds`);
				throw new Error(`${text ? text + "\n\n" : ""}Command exited with code ${e.code ?? "?"}`);
			}
		},
	});
}