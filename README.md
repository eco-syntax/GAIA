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
  voice notes are transcribed locally via whisper.cpp (the Docker image ships both plus English
  models; native installs set `"whisperModel": "/path/to/ggml-model.bin"`
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

### Which install is for me?

| You are on... | Install | Notes |
|---|---|---|
| **Windows 11** | [Docker Desktop quickstart](#windows-11-quickstart) | No WSL2, no Node, no build — two files + `docker compose up`; voice included |
| **macOS** (Apple Silicon or Intel) | [Docker install](#install-with-docker-windows-mac-linux) | Same as Windows minus the PowerShell specifics; arm64 + amd64 images published |
| **Linux, want the easy path** | [Docker install](#install-with-docker-windows-mac-linux) | Same two files; `docker compose` via the engine or the compose plugin |
| **Linux, want voice notes / no Docker** | [Native install](#install-on-linux-systemd-no-docker) | systemd + bubblewrap sandbox (the Docker install also includes voice) |
| **Already running WSL2** | Either — inside WSL use the [native install](#install-on-linux-systemd-no-docker), or just Docker Desktop on Windows and skip WSL entirely | |

### Install with Docker (Windows, Mac, Linux)

You need [Docker Desktop](https://docs.docker.com/get-docker/) (Windows/Mac) or
the Docker engine (Linux). Nothing else — no Node.js, no build tools. The image
is published on every release to
[`ghcr.io/eco-syntax/gaia`](https://github.com/eco-syntax/GAIA/pkgs/container/gaia).

**0. One-time for the repo owner** (already done for v0.2.0+ — listed here for
the first-ever publish): newly published GHCR packages start **private**. After
the first release workflow runs, open the repo → Packages → `gaia` → Package
settings → change visibility to **Public**. Until then, `docker compose pull`
fails with "unauthorized".

**1. Get the two files.** From a release, download
[`docker-compose.yml`](https://github.com/eco-syntax/GAIA/blob/main/docker-compose.yml)
and [`.env.example`](https://github.com/eco-syntax/GAIA/blob/main/.env.example)
into a new folder (or clone the repo). On Windows: plain PowerShell, no WSL
needed — create the folder wherever you like, e.g. `C:\Users\you\GAIA`.

**2. Configure tokens.** Copy `.env.example` to `.env` (same folder) and fill
in at least one chat platform. For Telegram:

- Message [@BotFather](https://t.me/BotFather) → `/newbot` → paste the token
  into `GAIA_TELEGRAM_BOT_TOKEN=...`
- Send your new bot any message once, then fetch the chat id:
  ```bash
  curl "https://api.telegram.org/bot<PASTE-TOKEN>/getUpdates"
  ```
  and put the `"chat":{"id":...}` number into `GAIA_ALLOWED_CHAT_IDS=...`.
  Only these chats can talk to the agent.
- If you add the bot to a **group** later, also set
  `GAIA_ALLOWED_TELEGRAM_USER_IDS` (who may act there); group messages are
  ignored without it.

**3. Pick a model.** Two easy paths:

- **LM Studio on the same machine** (recommended with a GPU): install it,
  download a model, enable *Developer → Serve on Local Network* (port 1234),
  and set in `.env`:
  ```
  GAIA_MODEL=lmstudio/<model-id>
  LLAMA_BASE_URL=http://host.docker.internal:1234
  ```
  (`host.docker.internal` = "the machine running Docker" — works out of the box.)
- **Bundled llama.cpp**: put your model file at `models/model.gguf` next to
  `docker-compose.yml`, set `GAIA_MODEL=llama-cpp/<model-name>`, and use the
  `--profile llama` start command below.

**4. Start it:**

```bash
docker compose pull
docker compose up -d                    # own model server
docker compose --profile llama up -d    # bundled llama.cpp instead
docker compose logs -f gateway          # watch it connect (Ctrl+C stops watching)
```

Then message your bot. `/status` shows sandbox, model, and bash state.

**5. Files to and from the agent.** The `workspace/` folder next to
`docker-compose.yml` is the agent's `/workspace` — same folder, two names:

- **Give it a file**: drop `report.pdf` into `workspace/`, then tell the agent
  "read /workspace/report.pdf and summarize".
- **Get a file back**: "save the summary to /workspace/summary.md" — it appears
  in `workspace/` seconds later.
- Nothing else on your computer is visible to it. To share more, add a volume
  line under `volumes:` in `docker-compose.yml`
  (e.g. `- ~/projects:/projects:ro` for read-only) and restart.

**Update / reset:**

```bash
docker compose pull && docker compose up -d     # update to the latest release
docker compose down && docker compose up -d     # restart (workspace and data survive)
delete the contents of data/                    # full reset — memory and history erased
```

To pin a version instead of `latest`, set `image: ghcr.io/eco-syntax/gaia:vX.Y.Z`
in `docker-compose.yml`. A `.env` file is machine-local secret material — never
commit it (already in `.gitignore`).

Voice works in the container out of the box: the image ships piper (replies as
Telegram voice notes), whisper.cpp (incoming voice notes are transcribed), and
their English models — same pinned downloads as the native install. Send a
voice note to test. (Models are baked at build time; ~210 MB of image size.)

<details>
<summary>Build the image yourself instead of pulling it</summary>

If you'd rather not trust the published image (it is built by CI from this repo
plus the GreenPi fork), build locally — needs Node 22 and a clone of both repos
(`~/GreenPi` for the fork):

```bash
./docker/build.sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

</details>

### Windows 11 quickstart

The five-step Docker walkthrough above, with the Windows specifics filled in:

1. **Install Docker Desktop** — default options, WSL2 backend. In
   Settings → General, enable **"Start Docker Desktop when you sign in"**
   (this is what makes the bot survive reboots on an always-on box).
2. **Get the two files** — from a release, save `docker-compose.yml` and
   `.env.example` into a folder like `C:\Users\you\GAIA`. Plain PowerShell —
   no WSL2, no Node, no build. (Cloning the repo works too.)
3. **Fill in `.env`** (Notepad is fine) — Telegram token + chat id per the
   walkthrough above, plus the model: LM Studio on the same PC
   (`GAIA_MODEL=lmstudio/<id>` + `LLAMA_BASE_URL=http://host.docker.internal:1234`,
   with *Developer → Serve on Local Network* enabled) or a `models/model.gguf`
   with the `--profile llama` start command.
4. **Start** — PowerShell, regular user:
   ```powershell
   cd C:\Users\you\GAIA
   docker compose pull
   docker compose up -d
   ```
   Message the bot, then run `/status` — it should say `sandbox: docker
   container`.
5. **Files** — `C:\Users\you\GAIA\workspace` *is* the agent's `/workspace`.
   Drop files in, ask for files back; nothing else on the PC is visible.
6. **Voice** — works out of the box, nothing to configure: send the bot a
   voice note and it transcribes it; replies come back as voice notes too
   (piper + whisper.cpp and their English models are baked into the image).

Always-on settings: keep the PC plugged in and set
Settings → System → Power → **Sleep: Never** (a sleeping PC is a dark bot).
Updating later: `docker compose pull && docker compose up -d` (and grab the new
`docker-compose.yml` from a release when one ships). Resetting: delete the
contents of `data\` — memory and history erased, `workspace\` untouched.

Using WSL2 instead of Docker Desktop? Possible, but Docker Desktop needs
nothing from WSL — use it unless you specifically want the native install's
systemd setup, in which case enable systemd in WSL (`wsl --install -d Ubuntu`,
add `[boot]\nsystemd=true` to `/etc/wsl.conf`) and follow the Linux install
below.

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
