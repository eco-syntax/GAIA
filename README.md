# GAIA (Green AI Assistant)

GAIA is a context-disciplined, local-first agent gateway built on [GreenPi](https://github.com/ColbyBrown/GreenPi)—a specialized fork of [pi](https://github.com/earendil-works/pi) optimized for high-performance, eco-friendly local LLM inference.

While most agents are designed for massive cloud-based context windows, GAIA is engineered for the reality of local models: **frugality is a feature, not a limitation.**

---

## 🌿 The Philosophy: Frugal Intelligence

Every token used is energy consumed. GAIA prioritizes:
- **Minimal Context Waste**: Strategies to prevent long conversations from bloating local model context windows.
- **Local-First Inference**: Built-in support for LM Studio, Ollama, llama.cpp, and vLLM.
- **Identity-Linked Memory**: Durable, searchable, and scoped memory that follows you across platforms.
- **Secure Autonomy**: A "container-first" security model that allows the agent to work for you without risking your host.

---

## 🚀 Core Pillars

### 1. Context Discipline (The Workflow)
To prevent "context exhaustion" in local models, GAIA implements a three-stage workflow:
- **`/plan` (Exploration)**: A read-only mode for browsing code, searching web, and discussing approach. The model's goal is to produce a decision-complete markdown plan.
- **`/act` (Implementation)**: A single-session implementation mode where the agent executes the plan. Invoking `/act` acts as a continuous approval for bash commands.
- **`/delegate <file>` (Execution)**: The "frugal-context escape hatch." GAIA spawns a **fresh, headless session** seeded *only* with your plan. This ensures the implementation phase has maximum available context, unburdened by the long history of the planning conversation.

### 2. Security & Containment
GAIA treats every tool response (web, shell, files) as untrusted.
- **OS Sandbox**: By default, the agent runs in a Docker container or `bubblewrap` sandbox. It only sees the `workspace/` (for files) and `data/` (for memory) directories.
- **The Bash Gate**: Shell access is **deny-by-default**. You must explicitly enable it via `/bash`. High-impact commands (like `rm -r` or `sudo`) require a second confirmation via `/bash force`.

### 3. Identity-Linked Memory & Recall
- **Identity Bridging**: Use `/link` to connect your Telegram, Slack, Discord, or Matrix accounts.
- **Unified Memory**: Linked identities share a single, durable `MEMORY.md`.
- **FTS5 Recall**: The `recall` tool provides high-speed, full-text search over all historical session logs, providing a one-shot summary of relevant past context.

---

## 🛠 Command Reference

| Command | Description |
|:---|:---|
| `/new` | Start a fresh session. |
| `/model` | Pick a provider and model (local or eco-friendly cloud). |
| `/plan` | Enter read-only planning mode. |
| `/act` | Enter implementation mode (approves bash). |
| `/delegate <file>`| Run a plan in a fresh, zero-history session. |
| `/link [code]` | Bridge identity to another platform. |
| `/bash` | Enable/disable the bash tool for this session. |
| `/bash force` | One-shot bypass for high-impact commands. |
| `/status` | Check sandbox, model, and bash gate state. |
| `/stop` | Interrupt a running turn. |

---

## ⚡ Quick Start (Docker)

The fastest way to run GAIA on Windows, Mac, or Linux. Everything runs in two containers: the GAIA gateway, and (optionally) a llama.cpp model server.

### 1. Install Docker Desktop

Download and install [Docker Desktop](https://docs.docker.com/get-docker/) (Windows or Mac) or [Docker Engine](https://docs.docker.com/engine/install/) (Linux). Start it and make sure it's running — on Windows/Mac it lives in the system tray/menu bar, and the whale icon should be steady (not animating).

Open a terminal:
- **Windows**: PowerShell (Start → type "PowerShell")
- **Mac**: Terminal (Applications → Utilities)
- **Linux**: your usual shell

Check Docker works:
```bash
docker --version
```

### 2. Get GAIA and configure it

Download and extract the [release ZIP](https://github.com/eco-syntax/GAIA/releases) (or `git clone https://github.com/eco-syntax/GAIA.git`), then open a terminal in that folder.

Create your config file by copying the example:

```powershell
# Windows (PowerShell)
copy .env.example .env
notepad .env
```
```bash
# Mac / Linux
cp .env.example .env
nano .env   # or any editor
```

In `.env`:
- Set `GAIA_TELEGRAM_BOT_TOKEN` to the token [@BotFather](https://t.me/BotFather) gave you when you created your bot.
- Set `GAIA_ALLOWED_CHAT_IDS` to your numeric chat id. To find it: message your bot once (any text), then open `https://api.telegram.org/bot<YOUR-TOKEN>/getUpdates` in a browser and look for `"chat":{"id":123456789}` in the response.

### 3. Choose a model path — pick ONE

**Option A: All-in-one (bundled llama.cpp)** — for a self-contained setup with no other AI tools installed.

1. Create a `models` folder next to `docker-compose.yml`.
2. Download a `.gguf` model into it — e.g. the CPU-friendly [Qwen3.5-9B Q4_K_M](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/blob/main/Qwen3.5-9B-Q4_K_M.gguf) (~5.7 GB, runs on any modern PC, no GPU needed). Keep the filename as-is (e.g. `Qwen3.5-9B-Q4_K_M.gguf`).
3. In `.env`, set the model to the filename **without** the `.gguf` extension:
   ```
   GAIA_MODEL=llama.cpp/Qwen3.5-9B-Q4_K_M
   ```

**Option B: Use a model server you already run (LM Studio, Ollama, …)**

1. In `.env`, set the model to that server's provider and a model id it serves, e.g.:
   ```
   GAIA_MODEL=lmstudio/qwen3.5-9b
   ```
2. Point GAIA at it — set this in `.env` to override the compose default (which assumes the bundled Option A service):
   ```
   LLAMA_BASE_URL=http://host.docker.internal:1234
   ```
   (`host.docker.internal` is how containers reach a server on your own machine; `1234` is LM Studio's default port, Ollama's is `11434`.)

### 4. Start

```bash
docker compose pull        # download the GAIA image (first run only)
```

Then, depending on your choice above:

```bash
# Option A (includes the model server):
docker compose --profile llama up -d

# Option B (gateway only):
docker compose up -d
```

Watch it come up (Ctrl+C to stop watching — the containers keep running):

```bash
docker compose logs -f gateway
```

### 5. Verify

Message your bot on Telegram and send `/status`. It should reply with its sandbox, model, and bash-gate state. Model not right? Switch any time in chat with `/model`.

To stop everything: `docker compose down` (add `--profile llama` if you used Option A).

---

## ⚙️ Configuration

### Environment Variables (`.env`)
- `GAIA_TELEGRAM_BOT_TOKEN`: Your Telegram bot token.
- `GAIA_ALLOWED_CHAT_IDS`: Comma-separated allowed chat IDs.
- `GAIA_MODEL`: Default model (e.g., `ollama/llama3`).
- `LLAMA_BASE_URL`: Model server URL — only needed for the bundled llama.cpp service or an OpenAI-compatible endpoint on another host (LM Studio, Ollama, …).

### Gateway Config (`~/.gaia/config.json`)
Used for platform tokens (Slack, Discord, Matrix) and advanced model routing:
- `planModel`: A smaller/faster model for `/plan` mode.
- `actModel`: A stronger model for `/act` or `/delegate` modes.

---

## 🛠 Installation

### Docker (Windows, Mac, Linux)
Recommended for all platforms. Requires [Docker Desktop](https://docs.docker.com/get-docker/) (Windows/Mac) or Docker Engine (Linux).
- **Image**: `ghcr.io/eco-syntax/gaia`
- **Setup**: Follow the [Quick Start](#quick-start-docker) above.

### Linux Native (systemd, no Docker)
For Linux hosts where you would rather run without Docker. Requires bubblewrap (for the sandbox — installed automatically if missing):
```bash
git clone https://github.com/eco-syntax/GAIA.git ~/GAIA
cd ~/GAIA
./install.sh
```
*Note: `install.sh` installs a fork of `pi` ("GreenPi") to manage local dependencies. It does **not** install a model server by default: if it detects LM Studio, Ollama, or llama.cpp already running, GAIA uses that. If the machine has nothing else, it *offers* to install a llama.cpp router plus the CPU-friendly [Qwen3.5-9B](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF) model (~5.7 GB, runs without a GPU) — accepting is one keystroke, declining leaves the model unset so you can pick any provider later with `/model`. Set `GAIA_NO_LOCAL=1` to skip the offer entirely (non-interactive installs).*

### macOS
Use the **Docker installation** described above. The `install.sh` script requires `systemd`, which is not native to macOS.

---

## 📖 Technical Architecture

GAIA is built on the **GreenPi** engine, which provides:
- **Context-Aware Tooling**: Custom implementations of `read`, `edit`, and `write` that prevent prompt injection and ensure file access remains within the sandbox.
- **Frugal Web Tools**: `fetchpage` caps results to prevent context flooding and saves full text to disk.
- **Memory Staging**: Memory updates from untrusted sources (web, command output) are staged for user approval via `/memory-approve`.
