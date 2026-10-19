# Security plan: container-first

Updated 2026-10-18: reframed around OS containment as the primary control
(the 2026-09-08/15 layers below remain, reframed per the container model).
Status: **implemented** — `src/sandbox.ts` (bwrap / docker / `--unsafe`),
`docker/Dockerfile` + `docker-compose.yml`, env redaction + memory staging +
bash gate in `src/security.ts`; self-check: `npx tsx tests/security-check.ts`.

## The model: three assets, three controls

GAIA is a chat-reachable agent whose whole job is running shell commands. The
2026-09 plan gated commands in-process because the process ran on the host.
That inverted the burden: the easy path was unsandboxed, and users had to
understand prompt injection to be safe. The containment is now the default
shape of an install, and the in-process gates each protect one specific asset
a filesystem boundary cannot:

| Asset | Why the container can't cover it | Control |
|---|---|---|
| **The mount** (`./workspace`) | Host data, deliberately shared in — the boundary's job ends at the mount | Destructive-command friction tier (`/bash force`) |
| **The agent's credentials** (chat tokens, model API keys) | The process must hold them in env to work; `printenv` is unstoppable from outside | Secret redaction in tool output (`security.ts redactSecrets`) |
| **The agent's memory** (`./data/MEMORY*`) | Survives container resets — a poisoned entry is a stored prompt injection that outlives every rebuild | Memory staging + `/memory-approve` (untrusted-content taint) |

Everything else inside the container is disposable: screwed up means
`docker compose down && docker compose up` (or a bwrap restart), and the
environment rebuilds itself. That is the point of containerization, and the
plan leans on it instead of duplicating it.

## L0 — OS sandbox (default, not opt-in)

The gateway **refuses to start unsandboxed** unless `--unsafe` is passed:

- **Docker (recommended, all platforms):** the image sets
  `GAIA_SANDBOX=docker`. One container holds GAIA + GreenPi (+ optional
  llama.cpp); the only mounts are `./workspace` (the file passage) and
  `./data` (state). Tokens ride `env_file`, never files the agent could read.
- **bwrap (Linux, no Docker):** the gateway re-execs itself under bubblewrap —
  home invisible, workspace + state writable, env an allowlist (host-exported
  secrets like `GH_TOKEN`/`AWS_*` do not cross). Verified working unprivileged
  (userns); hosts where userns is blocked fall through to the refusal below.
- **systemd directives** (`pi-gateway.service`): kept as defense-in-depth but
  **no longer claimed as containment** — verified on the primary dev host that
  a user manager rejects every mount-namespace directive
  (`Unknown assignment: ProtectHome=…`), so they silently no-op there.
- **`--unsafe`:** bare process, red banner on every startup. Exists for
  development; a user who reaches it has read the warning twice.

## L1 — the three in-process controls (see table above)

1. **Env redaction** — `redactSecrets()` strips captured secret values
   (env names matching `TOKEN|KEY|SECRET|PASSWORD`, value ≥ 12 chars) from
   bash/web tool output. Stops the direct `printenv` exfil; an obfuscated
   exfil is the container's job, not this filter's.
2. **Memory staging** — saves made after untrusted content (web, file,
   command output) entered the session are staged per memory file (#120) until
   `/memory-approve`. Justification: memory outlives container resets.
3. **Bash gate + friction tier** — unchanged from 2026-09-15 (below): closed
   by default, `/bash` opens, `/bash force` is the second approval for
   destructive commands. Under L0 the gate's role is protecting the mount and
   pacing the agent, not containing the process.

## Access to files = the workspace

The agent sees exactly one shared folder (`/workspace` in Docker, the
configured workspace path under bwrap). Files pass through it in both
directions; nothing else on the host is visible. There is no per-file policy
matrix — visibility is the permission, decided by what you put in the folder.

## The one-shot read fix (#115/#116/#121)

`runOneShot` now excludes pi's ungated built-in `read` from every headless
session and `edit`/`write` unless explicitly requested (the recall summary's
truthy empty `tools: []` previously disabled exclusion entirely). Scheduled
tasks share the owning chat's bash gate and get web tools — a scheduled
command runs only when the owner has bash open. Under L0 this is redundancy;
in `--unsafe` it is the only thing between a scheduled prompt and the host.

## Telegram group authorization (#60)

Group chats require the sender to be on `allowedTelegramUserIds` (fail closed
when unset, with a startup warning); private chats match chat id == sender id.
Before this fix, any member of an allow-listed group had full agent control.

---

# History: the 2026-09-08/15 in-process plan

Everything below predates the container reframe and remains accurate for the
in-process layer, with two corrections: the systemd section's containment
claims (see L0 above), and issue #82's read-exclusion rationale, which the
container now provides structurally (visibility = permission) while the
one-shot exclusion above closes the headless gaps.

## Threat model

GAIA is a Telegram-reachable agent that can run arbitrary bash as the user, with
zero gates. The realistic attack isn't malice — it's **prompt injection**: the
agent fetches arbitrary web pages (`websearch`, `fetchpage`) and feeds them to a
model that can execute shell commands. Injected instructions like "run
`curl ... | sh`" previously just worked.

Container/VM/VPS isolation is the textbook fix (and pi's official position —
pi has no built-in sandbox and its docs say real isolation must come from the
OS boundary). But there's a cheaper, complementary layer that doesn't need one:
require a human to approve shell access.

## Why not an allowlist (issue #58)

The first implementation used a prefix allowlist (`"git *"`, `"npm test"`) over
the first token of each shell segment. That was **unsound**: any allowlisted
binary that can itself spawn a subprocess grants arbitrary code execution,
defeating the deny-by-default control:

```
git -c alias.pwn=!id pwn        # git runs the alias body via /bin/sh
git -c alias.pwn=!sh pwn        # arbitrary shell
find . -exec sh -c 'id' \;      # find spawns a shell per -exec
npm test --prefix /tmp/evil     # npm runs hooks from an arbitrary dir
```

The string contains no `$`, backtick, `<`, `>`, or lone `&`, so the old
metacharacter guard never fired and the segment matched `git *` / `find *` /
`npm *`. A prompt-injected model reached `execFileAsync("bash", ["-c", ...])`
unchallenged.

A prefix allowlist over programs that can exec **cannot be made safe**. The fix
is to stop pattern-matching entirely.

## The interception point (verified in pi's SDK docs)

- `createAgentSession()` accepts `excludeTools: ["bash"]` and `customTools`.
- So: remove the built-in bash, register our own `bash` tool in its place.
- Every command — any chat, any schedule, any vector — then flows through one
  function we own. Root-cause fix: one guard in the shared path.
- GAIA already centralizes session creation in `src/session.ts`
  (`ChatSessions.get` + `runOneShot`), so there is one place to wire it.

## Plan (implemented)

### 1. Per-command approval gate — `src/security.ts`

- Delete the allowlist and metacharacter matcher.
- `BashGate` keys one decision per chat. **Default = closed**: every bash
  command is refused, and the tool tells the model to ask the user.
- `bashGateTool(chatId)` shadows the built-in `bash` in both `ChatSessions.get()`
  and `runOneShot()` in `src/session.ts`. Headless one-shots (`NO_CHAT`,
  scheduled tasks without an open gate) are always closed — no user present.

### 2. `/bash` chat command — `src/index.ts`

- `/bash` (or `/bash on`) approves bash for the current chat session, showing a
  security warning first. `/bash off` re-locks it. `/new` / `/start` resets the
  gate to closed, so approvals never leak across sessions.
- This replaces Hermes-style interactive y/N approval deliberately. Live y/N is
  buildable (inline keyboards work end-to-end for `/model`), but GAIA's user
  texts an agent and puts the phone away, so per-command approval stalls every
  shell-using turn until a human reads a notification. In practice that pushes
  users to "always approve" at the start of any task, which collapses to
  today's `/bash` for no gain. The destructive tier below adds friction only at
  the footguns.

### 2b. Destructive-command friction tier — `src/security.ts`

A second layer on top of the binary gate. Once `/bash` opens a chat
  (`"open"` state), high-blast-radius commands are still refused once and the
  model is told to ask the user to re-confirm with `/bash force` (a one-shot) or
  run it themselves. This is **not a denylist**: a flagged command still runs
  after the user re-confirms. `/act` and `/delegate` set `"trusted"` — their
  invocation IS the human sign-off for the whole plan.

- `/bash force` sets a one-shot: the next destructive command bypasses the
  friction tier, then the flag is consumed.

Ceiling: classification is regex over the raw command string. It catches the
  obvious footguns a model reaches for blindly (`rm -r`, `sudo`, `mkfs`, `git
  push --force`, `curl|sh`) and misses anything obfuscated. Acceptable because
  the binary gate stays closed-by-default and L0 is the real boundary — this
  tier is friction, not a security control.

### 3. `fetchpage` origin guard (exfiltration)

`fetchpage` refuses any URL that is not a bare site origin (no path, query, or
fragment), because a prompt-injected page can smuggle a secret to a public
server in the query string, path, or fragment. `websearch` posts its query in
the body and is unaffected — which is why L1's redaction and L0 matter more
than URL shape.

## Verification

- `npx tsc --noEmit` && `npm test` (`tests/security-check.ts` covers the gate,
  the destructive tier, staging isolation per memory file, secret redaction,
  the SSRF and fetch guards, and sandbox mode resolution).
- Sandbox live checks: `--unsafe`-less bare start refuses; `GAIA_SANDBOX=off
  --unsafe` prints the red banner; a bwrap start prints the bubblewrap line and
  the child cannot see `~/.ssh`; a docker start cannot see `/home/colby` and a
  file written to `/workspace` appears in the host's `./workspace`.
