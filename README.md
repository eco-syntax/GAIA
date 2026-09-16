# pi-gateway

A minimal Hermes-style companion for [pi](https://github.com/earendil-works/pi): chat gateway,
scheduled tasks, web research, and local voice — built entirely on pi's SDK, no pi-core changes.

## What it does

- **Multi-platform chat**: Telegram (long-poll), Slack (Socket Mode), Discord (gateway websocket),
  and Matrix (client-server sync) — each chat gets its own persistent pi session (full agent: files,
  bash, skills). Configure whichever platforms you need in `~/.pi-gateway/config.json`; each has its
  own fail-closed allow-list.
- **Identity linking**: the same authorized user can bridge chats across platforms with `/link`. In a
  1:1 DM, `/link` shows a one-time 6-char code; run `/link <code>` in the other 1:1 chat you want to
  join (either direction works). No passwords in plain text — the code proves access to both chats.
  Linked chats share one memory file and recall only searches that identity's logs, never anyone
  else's. `/whoami` shows the linked identity. Linking is restricted to 1:1 DMs only, never group chats.
- **Scheduled tasks**: schedules are just `{name, every|at, chatId, prompt}` records in
  `~/.pi-gateway/schedules.json` — the gateway runs a headless pi turn on a timer and delivers the
  result to the chat. No job types, no DSL.
  A `schedule` tool is exposed to the agent too, so GAIA can set/list/remove recurring tasks itself at
  runtime (interval `30m`/`2h`/`1d` or daily `HH:MM`); the live registry needs no restart. Each result is also appended into the target
  chat's session log (set `"inject": false` on a schedule to opt out), so follow-ups like "what did
  the scan say about X?" are grounded in what the task actually found rather than posted in isolation.
- **Web research**: built-in `websearch` + `fetchpage` tools (DuckDuckGo, no API keys; full page text
  saved to `~/.pi-gateway/research/`, capped in context like Hermes's approach).
- **Memory & recall**: durable user facts live in a capped `MEMORY.md`, injected as session messages (never into the system prompt). The `recall` tool is full-text search (SQLite FTS5, incrementally indexed) over all persisted session logs, with a one-shot LLM summary of the hits — Hermes-style cross-session recall, also delivered as a tool result.
- **`/plan <idea>`**: one-shot spec writer — numbered build plan with file paths and acceptance criteria.
- **Chat commands**: `/new` (fresh session, prints the current model), `/model` (interactive two-level menu: pick a provider, then a model; the typed `/model provider/id` still works),
  `/stop` (interrupt a running turn), `/link [code]` (identity bridging across platforms),
  `/whoami` (show the linked identity), `/plan` — registered in Telegram's slash-command menu
  (and typed directly on every other platform). Sending any new message also interrupts a running
  turn (Hermes-style interrupt-and-redirect).
- **Voice**: replies as Telegram voice notes via local `piper` (+ ffmpeg for OGG/Opus). Incoming
  voice notes are transcribed locally via whisper.cpp (set `"whisperModel": "/path/to/ggml-model.bin"`
  in the config; needs a `whisper-cli`/`whisper` binary and ffmpeg on PATH).
- **Bash approval gate**: the built-in bash tool is shadowed by a deny-by-default gate
  (`src/security.ts`). There is no command allowlist — every bash command is
  refused until you approve it for the current session with `/bash` (which shows
  a security warning; `/bash off` re-locks it; `/new`/`/start` resets to locked).
  The systemd unit adds OS-level containment
  (ProtectSystem/ProtectHome/PrivateTmp) as a second layer — see `docs/security-plan.md`.

## Setup

`./install.sh` also installs and starts a llama.cpp router as a systemd user
service (pinned build, port 8080), downloads the apertus default model, and
creates the gateway config interactively (token prompt, chat-id detection,
llama.cpp + apertus default). Manual setup, if you prefer:

```bash
npm install
mkdir -p ~/.pi-gateway
cat > ~/.pi-gateway/config.json <<'EOF'
{
  "telegramBotToken": "123:ABC",
  "allowedChatIds": [123456789],
  "slackBotToken": "xoxb-…",
  "slackAppToken": "xapp-…",
  "allowedSlackChatIds": ["C0123ABC"],
  "discordBotToken": "…",
  "allowedDiscordChatIds": ["123456789"],
  "matrixHomeserver": "https://matrix.example.org",
  "matrixUserId": "@gaia:example.org",
  "matrixAccessToken": "…",
  "allowedMatrixRoomIds": ["!room:example.org"],
  "model": { "provider": "lmstudio", "id": "qwen3-32b" },
  "piperVoice": "/opt/piper/voices/en_US-lessac-medium.onnx"
}
EOF
cat > ~/.pi-gateway/schedules.json <<'EOF'
[
  { "name": "morning-brief", "at": "08:00", "chatId": 123456789,
    "prompt": "Check my open PRs with gh and summarize anything needing attention." }
]
EOF
npm start
```

Any single platform is enough — omit the others. Every configured platform needs its
allow-list populated (a chat id / channel id / room id per platform) or the gateway
refuses to start; Slack needs both a bot token (`xoxb-…`) and a socket-mode app token
(`xapp-…`). Schedules take an optional `"platform": "telegram" | "slack" | "discord" | "matrix"`
(default `telegram`).

Model is optional — omit it and pi's default resolution applies (local providers like LM Studio,
Ollama, vLLM, llama.cpp are built in; see pi's providers doc).

### Docker

Runs as a non-root user with no access to host secrets; the only host path it
touches is the `~/.pi-gateway` volume. Complements the bash approval gate and
the systemd unit's hardening (see `docs/security-plan.md`).

```bash
docker build -t pi-gateway .
docker run -d --name pi-gateway \
  -v ~/.pi-gateway:/home/gaia/.pi-gateway \
  --add-host host.docker.internal:host-gateway \
  pi-gateway
```

Create `~/.pi-gateway/config.json` first (manual setup above). Point the model
config at `host.docker.internal` instead of `localhost` — e.g. the llama.cpp
router is `http://host.docker.internal:8080`. For voice, the `piperVoice` path
must exist in the container: mount the voice dir (`-v /opt/piper/voices:/opt/piper/voices:ro`).

## Context-budget discipline

The design targets 32K-token local models:

- Chat sessions start from pi's lean default prompt; no skill packs loaded.
- `fetchpage` caps tool results (~5K tokens) and dumps full text to disk.
- Scheduled tasks and `/plan` run as one-shot in-memory sessions — they never touch chat history.
- Multi-hour chats rely on pi's compaction (tool-result pruning included).

## Not built (deliberately)

Skill packs, user modeling, job DSLs, account integrations beyond
MCP servers (use `pi-mcp-adapter` with community Google/M365 MCP servers).
