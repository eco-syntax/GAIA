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
- **Plan / Act / Delegate**: a conversational plan-act workflow like Cline, Codex, and OpenCode, tuned for frugal local-model context budgets:
  - `/plan` — toggle plan mode (read-only exploration + planning). Same session, conversation persists. Bash stays locked; a `write_plan` tool lets the agent persist the agreed plan to `~/.pi-gateway/plans/*.md` as a durable, decision-complete artifact. `/plan` again to exit.
  - `/act` — implement the plan in the same session. Bash is approved (the `/act` invocation is the approval); the steering goal becomes "implement the agreed plan."
  - `/done` — exit act/plan mode, re-lock bash, return to normal.
  - `/delegate <file>` — implement a plan file in a **fresh headless session** seeded with only the plan (no chat history). The `/delegate` invocation is the approval; the spawned session writes freely, reports back, and exits. This is the frugal-context escape hatch: a long planning conversation never blows the context window of a local model, because implementation runs with just the plan.
  - Optional per-mode models: set `planModel` (cheap, for read-only planning) and `actModel` (stronger, for implementation) in the config. `/plan` swaps to the plan model, `/act` and `/delegate` swap to the act model, `/done` restores the default. Omit either to use the default `model` for that phase — the common single-model setup is unchanged.
- **Chat commands**: `/new` (fresh session, prints the current model), `/model` (interactive two-level menu: pick a provider, then a model; the typed `/model provider/id` still works),
  `/stop` (interrupt a running turn), `/link [code]` (identity bridging across platforms),
  `/whoami` (show the linked identity), `/plan`, `/act`, `/done`, `/delegate`, `/restart` (restart the gateway) — registered in Telegram's slash-command menu
  (and typed directly on every other platform). Sending any new message also interrupts a running
  turn (Hermes-style interrupt-and-redirect).
- **Voice**: replies as Telegram voice notes via local `piper` (+ ffmpeg for OGG/Opus). Incoming
  voice notes are transcribed locally via whisper.cpp (set `"whisperModel": "/path/to/ggml-model.bin"`
  in the config; needs a `whisper-cli`/`whisper` binary and ffmpeg on PATH).
- **Attachments**: documents, images, and files attached to a message (Telegram, Slack, Discord,
  and Matrix) are downloaded into a per-chat inbox and offered to the agent through the
  `open_attachment` tool, so a file-only message (e.g. a lone PDF) is processed instead of being
  ignored. Text files (logs, configs, code) are returned inline (capped like `fetchpage`); binary
  files report their mime/size. Files are capped and the tool reads only its own inbox — it never
  reopens the ungated file-tool hole the chat sessions deliberately close.
- **Bash approval gate**: the built-in bash tool is shadowed by a deny-by-default gate
  (`src/security.ts`). There is no command allowlist — every bash command is
  refused until you approve it for the current session with `/bash` (which shows
  a security warning; `/bash off` re-locks it; `/new`/`/start` resets to locked).
  Even after `/bash`, high-blast-radius commands (`rm -r`, `sudo`, `mkfs`,
  `git push --force`, `curl|sh`, …) are refused once more; approve that one
  command with `/bash force` (one-shot) or run it yourself. `/act` and
  `/delegate` are full approvals that skip this friction tier.
  The OS sandbox (container or bubblewrap) is the real boundary — the agent
  only ever sees its workspace folder. See `docs/security-plan.md`.

## Setup

> **Trust model**: the agent runs shell commands. Who can trigger it (the chat
> allow-list) and what it can touch (the sandbox) are separate questions — the
> sandbox means "the agent can run shell" no longer implies "on your host".
> Details in `docs/security-plan.md`; the short version is below.

### The sandbox in one paragraph

By default the agent runs inside a container and sees only two folders:
`workspace/` (its files — the passage to and from you) and `data/` (its memory
and conversation history, which survive resets). Your home directory, SSH keys,
and config are invisible to it. Credentials (chat tokens, model API keys) are
passed as environment variables and redacted from anything the agent prints.
Running without the sandbox requires an explicit `--unsafe` flag and prints a
red warning on every startup.

### Install with Docker (Windows, Mac, Linux)

You need [Docker](https://docs.docker.com/get-docker/) (on Windows or Mac:
**Docker Desktop**; on Linux: the Docker engine). No Node.js, no systemd, no
WSL2 required.

**1. Build the image.** The build packages GAIA together with its GreenPi fork
from local tarballs (built automatically if needed — requires `~/GreenPi` on
Linux, or a one-time `./install.sh`-less clone):

```bash
git clone https://github.com/eco-syntax/GAIA.git
cd GAIA
./docker/build.sh
```

**2. Configure tokens.** Copy `.env.example` to `.env` and fill in at least one
chat platform. For Telegram: message [@BotFather](https://t.me/BotFather) →
`/newbot` → paste the token into `GAIA_TELEGRAM_BOT_TOKEN`. Then send your bot
any message once, and add the chat id from the gateway log to
`GAIA_ALLOWED_CHAT_IDS` and restart (step 4) — only these chats can talk to it.

**3. Pick a model.** The easiest path is the bundled llama.cpp service: put one
`.gguf` model file in the `models/` folder, name it `model.gguf`, and set
`GAIA_MODEL=llama-cpp/<model-name>` in `.env` (the exact id is in
`docker compose logs llama` after first start). Any OpenAI-compatible server
works too — point `LLAMA_BASE_URL` at it and set `GAIA_MODEL` to
`provider/id` (e.g. `lmstudio/qwen3-8b`).

**4. Start it:**

```bash
docker compose up -d                  # with your own model server
docker compose --profile llama up -d  # with the bundled llama.cpp service
```

`docker compose logs -f gateway` shows what it is doing; chat commands work as
documented below; `/status` shows the sandbox and model state.

**5. Pass files to and from the agent.** The `workspace/` folder next to
`docker-compose.yml` is the agent's file area — what you see is what it sees:

- **Give the agent a file** (a PDF, a log, a spreadsheet): copy it into
  `workspace/`. Tell the agent the path, e.g. "summarize /workspace/report.pdf".
- **Get a file back**: the agent writes it into `/workspace` — it appears in
  `workspace/` on your machine seconds later. Just ask ("save the summary to
  /workspace/summary.md").
- Nothing else on your computer is visible to the agent. To share more, add
  another volume line under `volumes:` in `docker-compose.yml`
  (e.g. `- ~/projects:/projects:ro` for read-only access) and restart.

**Update or reset:**

```bash
git pull && ./docker/build.sh && docker compose up -d   # update GAIA
docker compose down && docker compose up -d             # restart (workspace and data survive)
sudo rm -rf data/*                                       # full reset — memory and history erased
```

Voice notes are not included in the image (use the Linux install below, or add
piper/whisper to the image). A `.env` file is machine-local secret material —
never commit it (it is already in `.gitignore`).

### Install on Linux (systemd, no Docker) — Linux only

For Linux hosts where you would rather run without Docker. Requires bubblewrap
(for the sandbox — installed automatically if missing):

```bash
git clone https://github.com/eco-syntax/GAIA.git ~/GAIA
cd ~/GAIA
./install.sh
```

`./install.sh` installs and starts a llama.cpp router as a systemd user service
(pinned build, port 8080), downloads the apertus default model, and creates the
gateway config interactively (token prompt, chat-id detection, llama.cpp +
apertus default). The gateway starts inside a bubblewrap sandbox: the host home
is invisible, and the agent sees only its workspace (`~/gaia-workspace` by
default, set `"workspace"` in the config) and its state directory.

> **Notes**: `install.sh` installs a fork of pi ("GreenPi") and rewrites GAIA's
> `package.json` to point at its local tarballs — that is expected, and
> committing those paths is not (the working tree will show changes; leave
> them). To update GAIA later: `git pull` and re-run `./install.sh` (idempotent).
> **macOS**: use the Docker install above; `install.sh` needs systemd.

Manual setup (no sandbox — for development only; the gateway will refuse to
start without `--unsafe`):

```bash
npm install
mkdir -p ~/.pi-gateway
cat > ~/.pi-gateway/config.json <<'EOF'
{
  "telegramBotToken": "123:ABC",
  "allowedChatIds": [123456789],
  "allowedTelegramUserIds": [123456789],
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
  "planModel": { "provider": "lmstudio", "id": "qwen3-8b" },
  "actModel": { "provider": "lmstudio", "id": "qwen3-32b" },
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
(default `telegram`). `allowedTelegramUserIds` lists who may act in allow-listed
GROUP chats — private chats don't need it; groups are ignored without it.

Model is optional — omit it and pi's default resolution applies (local providers like LM Studio,
Ollama, vLLM, llama.cpp are built in; see pi's providers doc).

## Context-budget discipline

The design targets 32K-token local models:

- Chat sessions start from pi's lean default prompt; no skill packs loaded.
- `fetchpage` caps tool results (~5K tokens) and dumps full text to disk.
- Scheduled tasks run as one-shot in-memory sessions — they never touch chat history.
- `/delegate <file>` implements a plan in a fresh session seeded with only the plan file, so a long planning conversation never enters the implementation context.
- Multi-hour chats rely on pi's compaction (tool-result pruning included).

## Not built (deliberately)

Skill packs, user modeling, job DSLs, account integrations beyond
MCP servers (use `pi-mcp-adapter` with community Google/M365 MCP servers).
