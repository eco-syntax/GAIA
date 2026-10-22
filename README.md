# pi-gateway

A minimal Hermes-style companion for [pi](https://github.com/earendil-works/pi): chat gateway, scheduled tasks, web research, and local voice — built entirely on pi's SDK, no pi-core changes.

---

## Table of Contents
- [Core Features](#core-features)
- [Command Reference](#command-reference)
- [Security & Sandbox](#security--sandbox)
- [Quick Start (Docker)](#quick-start-docker)
- [Installation](#installation)
- [Configuration](#configuration)
- [Context Budgeting](#context-budgeting)
- [Not Built (Deliberately)](#not-built-deliberately)

---

## Core Features

- **Multi-platform Chat**: Supports Telegram, Slack, Discord, and Matrix. Each chat gets its own persistent `pi` session (full agent: files, bash, skills). Configure platforms in `~/.pi-gateway/config.json`.
- **Identity Linking**: Bridge chats across platforms using `/link`. Linked identities share one memory file and recall only searches from their own logs. Restricted to 1:1 DMs.
- **Scheduled Tasks**: Run headless `pi` turns on a timer. Schedules are defined in `~/.pi-gateway/schedules.json` as simple `{name, every|at, chatId, prompt}` records. Results can be automatically injected into chat logs for easy follow-up.
- **Web Research**: Built-in `websearch` and `fetchpage` tools (via DuckDuckGo; no API keys required). Full page text is saved to `~/.pi-gateway/research/`.
- **Memory & Recall**: Durable user facts live in a capped `MEMORY.md`. The `recall` tool provides full-text search (SQLite FTS5) over all persisted session logs, with a one-shot LLM summary of hits.
- **Plan / Act / Delegate**: A conversational workflow optimized for local-model context budgets:
  - `/plan`: Read-only exploration and planning mode.
  - `/act`: Implementation mode. Invoking `/act` acts as a single approval for bash commands.
  - `/delegate <file>`: Runs a plan in a **fresh headless session** seeded only with the plan file. This is the "frugal-context escape hatch" to prevent long conversations from blowing your context window.
- **Voice**: Supports voice notes via Telegram. Uses `piper` for text-to-speech and `whisper.cpp` for speech-to-text (English models included in Docker).
- **Attachments**: Automatically handles documents, images, and files attached to messages. Files are offered to the agent via the `open_attachment` tool.

---

## Command Reference

| Command | Description |
|:---|:---|
| `/new` | Start a fresh session (prints current model). |
| `/model` | Interactive menu to pick a provider and model. |
| `/stop` | Interrupt a running turn. |
| `/link [code]` | Link identity to another chat platform. |
| `/whoami` | Show the current linked identity. |
| `/plan` | Toggle read-only planning mode. |
| `/act` | Toggle implementation mode (approves bash). |
| `/done` | Exit plan/act mode and re-lock bash. |
| `/delegate <file>`| Run a plan in a fresh, focused headless session. |
| `/status` | Show sandbox, model, and bash state. |
| `/bash` | Enable bash tool for the current session. |
| `/bash force` | Single-use approval for "high-blast-radius" commands. |
| `/restart` | Restart the gateway. |

---

## Security & Sandbox

GAIA is designed with a **container-first** security model. The agent runs inside a sandbox (Docker or `bubblewrap`) and sees only two folders:
1. `workspace/`: The file passage to and from you.
2. `data/`: Its memory and conversation history.

Your host files, SSH keys, and credentials are invisible to the agent. Running without a sandbox requires the `--unsafe` flag and triggers a red warning on every startup.

### The Bash Gate
The built-in `bash` tool is **deny-by-default**. You must approve it for a session using `/bash`. Even after approval, "high-blast-radius" commands (like `rm -r` or `sudo`) require a second confirmation via `/bash force`.

For more details, see [docs/security-plan.md](./docs/security-plan.md).

---

## Quick Start (Docker)

The fastest way to get running on Windows, Mac, or Linux.

1. **Prepare Files**: Download `docker-compose.yml` and `.env.example` from a release into a new folder.
2. **Configure Telegram**: 
   - Create a bot via [@BotFather](https://t.me/BotFather) and get your token.
   - Set `GAIA_TELEGRAM_BOT_TOKEN=...` in your `.env` file.
   - Get your Chat ID via `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` and set `GAIA_ALLOWED_CHAT_IDS=...`.
3. **Pick a Model**:
   - **LM Studio**: Set `GAIA_MODEL=lmstudio/<id>` and `LLAMA_BASE_URL=http://host.docker.internal:1234` (ensure "Serve on Local Network" is enabled in LM Studio).
   - **Bundled llama.cpp**: Put a model in `models/model.gguf` and use the `--profile llama` start command.
4. **Start**:
   ```bash
   docker compose pull
   docker compose up -d
   ```
5. **Verify**: Message your bot and run `/status`.

---

## Installation

### Docker (Windows, Mac, Linux)
Recommended for all platforms. Requires [Docker Desktop](https://docs.docker.com/get-docker/) (Windows/Mac) or Docker Engine (Linux).
- **Image**: `ghcr.io/eco-syntax/gaia`
- **Setup**: Follow the [Quick Start](#quick-start-docker) above.

### Linux Native (systemd + bubblewrap)
For users who want to avoid Docker and use a local `systemd` user service.
```bash
git clone https://github.com/eco-syntax/GAIA.git ~/GAIA
cd ~/GAIA
./install.sh
```
*Note: `install.sh` installs a fork of `pi` ("GreenPi") to manage local dependencies.*

### macOS
Use the **Docker installation** described above. The `install.sh` script requires `systemd`, which is not native to macOS.

---

## Configuration

Configuration is handled via two main files:

### 1. Environment Variables (`.env`)
Used for sensitive secrets and global settings. **Never commit this file.**
- `GAIA_TELEGRAM_BOT_TOKEN`: Your Telegram bot token.
- `GAIA_ALLOWED_CHAT_IDS`: Comma-separated list of allowed Telegram chat IDs.
- `GAIA_MODEL`: The default model to use.
- `LLAMA_BASE_URL`: URL for local model providers (e.g., LM Studio).

### 2. Gateway Config (`~/.pi-gateway/config.json`)
Used for platform-specific tokens and advanced settings.
- `slackBotToken`, `discordBotToken`, `matrixAccessToken`, etc.
- `planModel` / `actModel`: Specific models for different workflow phases.
- `piperVoice`: Path to local Piper voice models.

---

## Context Budgeting

Designed to work efficiently with 32K-token local models:
- **Session Management**: Chat sessions start with a lean prompt.
- **Tool Capping**: `fetchpage` and other tools cap results (~5K tokens) and save full text to disk.
- **Headless Tasks**: Scheduled tasks run in one-shot sessions, preserving chat history.
- **Delegation**: `/delegate` runs implementation in a fresh session, keeping planning history out of the implementation context.

---

## Not Built (Deliberately)

- Skill packs
- User modeling
- Job DSLs
- Account integrations beyond MCP servers (use `pi-mcp-adapter` for Google/M365)
