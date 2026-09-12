# pi-gateway

A minimal Hermes-style companion for [pi](https://github.com/earendil-works/pi): chat gateway,
scheduled tasks, web research, and local voice — built entirely on pi's SDK, no pi-core changes.

## What it does

- **Telegram chat**: each chat gets its own persistent pi session (full agent: files, bash, skills).
- **Scheduled tasks**: `schedules` in config are just `{name, every|at, chatId, prompt}` — the
  gateway runs a headless pi turn on a timer and delivers the result to the chat. No job types, no DSL.
- **Web research**: built-in `websearch` + `fetchpage` tools (DuckDuckGo, no API keys; full page text
  saved to `~/.pi-gateway/research/`, capped in context like Hermes's approach).
- **`/plan <idea>`**: one-shot spec writer — numbered build plan with file paths and acceptance criteria.
- **Chat commands**: `/new` (fresh session), `/model [provider/id]` (list or switch models),
  `/stop` (interrupt a running turn), `/plan` — all registered in Telegram's slash-command menu.
- **Voice**: replies as Telegram voice notes via local `piper` (+ ffmpeg for OGG/Opus). Incoming
  voice notes are transcribed locally via whisper.cpp (set `"whisperModel": "/path/to/ggml-model.bin"`
  in the config; needs a `whisper-cli`/`whisper` binary and ffmpeg on PATH).
- **Bash allowlist**: the built-in bash tool is shadowed by a deny-by-default gate
  (`src/security.ts`). Every shell segment (`&&`, `;`, `|` split) must match an
  `"allowedCommands"` pattern (`"git *"`, `"npm test"`); anything else is refused and the agent
  asks the user, who approves with `/allow <prefix>`. The systemd unit adds OS-level containment
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
  "model": { "provider": "lmstudio", "id": "qwen3-32b" },
  "piperVoice": "/opt/piper/voices/en_US-lessac-medium.onnx",
  "schedules": [
    { "name": "morning-brief", "at": "08:00", "chatId": 123456789,
      "prompt": "Check my open PRs with gh and summarize anything needing attention." }
  ]
}
EOF
npm start
```

Model is optional — omit it and pi's default resolution applies (local providers like LM Studio,
Ollama, vLLM, llama.cpp are built in; see pi's providers doc).

### Docker

Runs as a non-root user with no access to host secrets; the only host path it
touches is the `~/.pi-gateway` volume. Complements the bash allowlist gate and
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

Skill packs, user modeling, multiple chat platforms, job DSLs, account integrations beyond
MCP servers (use `pi-mcp-adapter` with community Google/M365 MCP servers).
