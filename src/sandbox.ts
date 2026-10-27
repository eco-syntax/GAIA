// ============================================================================
// OS sandbox: the agent process starts with an empty filesystem view — the
// host home is invisible, and the only things mounted in are the workspace
// (read-write) and the state directory (read-write: memory, session logs,
// schedules, plans). Everything the agent can touch is there by explicit
// decision, printed at startup.
//
// Modes:
//   docker  — the whole process tree is already a container (GAIA_SANDBOX=docker
//             is set in the image). Nothing to do here.
//   bwrap   — re-exec the gateway under bubblewrap: no daemon, no root, works
//             wherever unprivileged user namespaces work. The sandbox boundary
//             is the kernel; there is no in-container policy matrix to get wrong.
//   off     — bare process. Only honored with --unsafe: the gateway refuses to
//             start unsandboxed otherwise, because the agent's whole job is
//             running shell commands that a prompt-injected model can aim.
//
// The gateway's own credentials (chat tokens, model API keys) live in its
// environment, deliberately: the process needs them to work, and env is the
// one thing no filesystem boundary hides — so the bash and web tools redact
// known secret values from their output (security.ts). The sandbox environment
// is an ALLOWLIST: the host's exported variables (GH_TOKEN, AWS_*, …) do not
// cross into the sandbox unless they are GAIA_*, a proxy, or basic runtime vars.
// ============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "./config.js";

export type SandboxMode = "docker" | "bwrap" | "off";

export const UNSAFE_FLAG = "--unsafe";

/** The workspace directory: everything the agent may read and write. */
export function workspaceDir(configWorkspace?: string): string {
	const dir = configWorkspace ?? process.env.GAIA_WORKSPACE ?? join(homedir(), "gaia-workspace");
	return dir.startsWith("~") ? join(homedir(), dir.slice(1)) : resolve(dir);
}

/** Resolve the effective sandbox mode without starting anything.
 * Explicit config wins; "auto" picks bwrap when bubblewrap exists. */
export function resolveSandboxMode(
	configSandbox: "auto" | "bwrap" | "docker" | "off" | undefined,
	unsafeFlag: boolean,
): SandboxMode {
	if (process.env.GAIA_SANDBOX === "docker") return "docker";
	if (process.env.GAIA_SANDBOX === "bwrap") return "bwrap";
	if (unsafeFlag) return "off";
	if (configSandbox === "off") return "off";
	if (configSandbox === "docker") return "docker";
	if (configSandbox === "bwrap") return "bwrap";
	return existsSync("/usr/bin/bwrap") || existsSync("/usr/local/bin/bwrap") ? "bwrap" : "off";
}

/** True when the gateway is already running inside its sandbox (container, or
 * re-exec'd under bwrap). index.ts calls enterSandbox() once at startup; this
 * makes that idempotent. */
export function isContained(mode: SandboxMode): boolean {
	return mode === "docker" || process.env.GAIA_SANDBOX === "bwrap";
}

/** Environment variables that cross the sandbox boundary. Everything else the
 * host exported (GH_TOKEN, AWS_SECRET_ACCESS_KEY, …) stays outside. */
const ENV_PASSTHROUGH = [
	"TERM",
	"LANG",
	"LANGUAGE",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"LLAMA_BASE_URL",
];

/** Re-exec the current process under bubblewrap with the host home hidden and
 * only the workspace + state directory visible (plus the gateway's own code
 * and node binary, read-only — the agent needs them to run, and can read its
 * own source safely). Resolves to the child's exit code; never returns while
 * the child runs. Throws when bubblewrap is missing. */
export function enterSandbox(
	mode: SandboxMode,
	workspace: string,
	argv: string[],
): Promise<number> {
	if (mode !== "bwrap" || isContained(mode)) return Promise.resolve(0);
	const bwrap = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"].find((p) => existsSync(p));
	if (!bwrap) throw new Error("sandbox mode bwrap requires bubblewrap — install it (e.g. `sudo apt install bubblewrap`)");

	// The mount sources must exist before bwrap binds them.
	mkdirSync(workspace, { recursive: true, mode: 0o700 });
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });

	// The gateway's own code (GAIA repo, incl. node_modules for the tsx loader)
	// and the node binary live on the host outside the sandbox view — bind them
	// read-only. sandbox.ts sits at <repo>/src/, so the repo root is two up.
	const thisFile = fileURLToPath(import.meta.url); // .../src/sandbox.js|ts
	const repoRoot = dirname(dirname(thisFile));
	const nodeBinDir = dirname(process.execPath);

	// Filesystem view: system read-only, /home and /tmp empty, then the two
	// writable paths bound back in at their real paths. HOME is the workspace,
	// so the read tool's ~ expansion can only ever reach shared files.
	// PATH includes ~/.local/bin and it is bound read-only: install.sh symlinks
	// the voice binaries (piper, whisper-cli) there, and /home is tmpfs'd away,
	// so without the bind the symlinks would not exist inside the sandbox.
	const localBin = join(homedir(), ".local/bin");
	const env: Record<string, string> = {
		HOME: workspace,
		PATH: existsSync(localBin) ? `${localBin}:/usr/local/bin:/usr/bin:/bin` : "/usr/local/bin:/usr/bin:/bin",
		GAIA_SANDBOX: "bwrap",
		// pi's config dir (~/.greenpi) would land inside the workspace — point it
		// at the state directory instead, where the agent's own machinery lives.
		GREENPI_CODING_AGENT_DIR: join(stateDir, "agent"),
	};
	for (const key of ENV_PASSTHROUGH) {
		if (process.env[key] !== undefined) env[key] = process.env[key]!;
	}
	// Pin the resolved workspace + state dir across the re-exec: the child's HOME
	// is the workspace, so any ~-derived default would nest inside it.
	env.GAIA_WORKSPACE = workspace;
	env.GAIA_STATE = stateDir;
	// GAIA_* is the config-override surface (tokens, allow-lists, model spec):
	// the gateway needs them, so they cross deliberately.
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("GAIA_") && value !== undefined) env[key] = value;
	}

	const args = [
		"--ro-bind", "/", "/",
		"--dev", "/dev",
		"--proc", "/proc",
		"--tmpfs", "/home",
		"--tmpfs", "/tmp",
		"--ro-bind", repoRoot, repoRoot,
		"--ro-bind", nodeBinDir, nodeBinDir,
		// voice binaries (piper, whisper-cli) are symlinked here by install.sh;
		// /home is tmpfs'd so the dir must be bound back or PATH lookups fail
		...(existsSync(localBin) ? ["--ro-bind", localBin, localBin] : []),
		"--bind", workspace, workspace,
		"--bind", stateDir, stateDir,
		"--",
		process.execPath,
		...argv,
	];
	// The child inherits bwrap's environment, and bwrap's env is exactly the
	// allowlist above — the host's exported variables never cross the boundary.
	const child = spawn(bwrap, args, {
		stdio: "inherit",
		cwd: workspace,
		env,
	});
	return new Promise((resolveExit, reject) => {
		child.on("error", reject);
		child.on("exit", (code, signal) => resolveExit(signal ? 1 : (code ?? 1)));
	});
}

/** What the agent can and cannot see — printed at startup and shown by /status. */
export function describeSandbox(mode: SandboxMode, workspace: string): string {
	if (mode === "docker") {
		return `docker container — host filesystem invisible except the mounted workspace (${workspace}) and the state volume`;
	}
	if (mode === "bwrap") {
		return `bubblewrap — host home invisible; writable: ${workspace} and ${stateDir}`;
	}
	return "OFF — the agent sees the host filesystem it runs on";
}
