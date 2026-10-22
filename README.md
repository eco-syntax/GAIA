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

The fastest way to run GAIA with local models.

1. **Prepare**: Download and extract the [release ZIP](https://github.com/eco-syntax/GAIA/releases) (or clone the repo) into a new folder.
2. **Configure Environment**:
   - Copy `.env.example` to `.env`.
   - Get a Telegram bot token from [@BotFather](https://t.me/BotFather) and set `GAIA_TELEGRAM_BOT_TOKEN=...` in `.env`.
   - Find your Chat ID via `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` and set `GAIA_ALLOWED_CHAT_IDS=...` in `.env`.
3. **Choose a Model Path**:

   **Option A: All-in-One (Bundled llama.cpp)** — *Best for a quick, self-contained setup*
   - Drop a `.gguf` file into the `./models` folder and rename it to `model.gguf`.
   - Launch with: `docker compose --profile llama up -d`

   **Option B: Use your own (LM Studio/Ollama)** — *Best if you already have a model running or have a GPU*
   - Set `GAIA_MODEL=lmstudio/<id>` (or your provider) in `.env`.
   - Set `LLAMA_BASE_URL=http://host.docker.internal:1234` (for LM Studio) in `.env`.
   - Launch with: `docker compose up -d`

4. **Launch**:
   ```bash
   docker compose pull
   ```
   *(Then follow the specific launch command for your chosen option above.)*

5. **Verify**: Message your bot and run `/status`.

---

## ⚙️ Configuration

### Environment Variables (`.env`)
- `GAIA_TELEGRAM_BOT_TOKEN`: Your Telegram bot token.
- `GAIA_ALLOWED_CHAT_IDS`: Comma-separated allowed chat IDs.
- `GAIA_MODEL`: Default model (e.g., `ollama/llama3`).
- `LLAMA_BASE_URL`: URL for local providers like LM Studio.

### Gateway Config (`~/.pi-gateway/config.json`)
Used for platform tokens (Slack, Discord, Matrix) and advanced model routing:
- `planModel`: A smaller/faster model for `/plan` mode.
- `actModel`: A stronger model for `/act` or `/delegate` modes.

---

## 📖 Technical Architecture

GAIA is built on the **GreenPi** engine, which provides:
- **Context-Aware Tooling**: Custom implementations of `read`, `edit`, and `write` that prevent prompt injection and ensure file access remains within the sandbox.
- **Frugal Web Tools**: `fetchpage` caps results to prevent context flooding and saves full text to disk.
- **Memory Staging**: Memory updates from untrusted sources (web, command output) are staged for user approval via `/memory-approve`.
