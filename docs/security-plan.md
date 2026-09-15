# Security plan: closing the bash free-for-all

Written 2026-09-08. Updated 2026-09-15 for issue #58: replaced the unsound
allowlist with a per-session approval gate. Status: **implemented** —
`src/security.ts`, `/bash` in `src/index.ts`, hardening in
`pi-gateway.service`; self-check: `npx tsx src/security-check.ts`.

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
`npm test`. A prompt-injected model reached `execFileAsync("bash", ["-c", ...])`
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
- `BashGate` keys one decision per Telegram chat. **Default = closed**: every
  bash command is refused, and the tool tells the model to ask the user.
- `bashGateTool(chatId)` shadows the built-in `bash` in both `ChatSessions.get()`
  and `runOneShot()` in `src/session.ts` (excludeTools: ["bash"] + custom gate
  tool). Headless one-shots (`NO_CHAT`, scheduled tasks) are always closed —
  there is no user present to approve.

### 2. `/bash` chat command — `src/index.ts`

- `/bash` (or `/bash on`) approves bash for the current chat session, showing a
  security warning first. `/bash off` re-locks it. `/new` / `/start` resets the
  gate to closed, so approvals never leak across sessions.
- This replaces Hermes-style interactive y/N approval deliberately: the
  gateway's turn loop is serialized, so an in-chat "reply y to approve" would
  deadlock. `/bash` keeps the same property — an explicit human-in-the-loop
  decision — with none of the plumbing.

### 3. systemd hardening — `pi-gateway.service`

The "no container needed" containment layer. The service file already exists;
add:

```ini
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.pi-gateway %h/GAIA
PrivateTmp=yes
RestrictSudo=yes
```

- Even a *successful* injection then can't write outside the state/workspace
  dirs, can't escalate, can't touch system paths.
- Gate and sandbox are complementary: the gate decides what ever runs; the
  sandbox limits what a running thing can do.
- Ceiling: container/VM/VPS (pi's docs point at a Gondolin micro-VM
  integration) is still stronger — see `Dockerfile`.

## Explicitly skipped

- **Deny-lists** — the gate subsumes them.
- **DM pairing** — `allowedChatIds` already is that.
- **Per-tool policies beyond bash** — read/write are bounded by ProtectHome;
  bash is the escalation vector.
- **Allowlists of any kind** — unsound (see issue #58).
- **Live y/N approval** — deadlocks against the serialized turn loop.

## Verification

- `npx tsc --noEmit`
- `npx tsx src/security-check.ts` — gate starts closed, refuses a benign
  command, runs it after `/bash`, and closes again on a new session.
- After service edit: `systemctl --user daemon-reload && systemctl --user
  restart pi-gateway` and confirm the agent asks for `/bash` before running
  anything, then runs after approval.