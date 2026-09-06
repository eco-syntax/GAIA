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
- **Voice**: replies as Telegram voice notes via local `piper` (+ ffmpeg for OGG/Opus). Incoming
  transcription (whisper.cpp) is not wired up yet.

## Setup

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

## Context-budget discipline

The design targets 32K-token local models:

- Chat sessions start from pi's lean default prompt; no skill packs loaded.
- `fetchpage` caps tool results (~5K tokens) and dumps full text to disk.
- Scheduled tasks and `/plan` run as one-shot in-memory sessions — they never touch chat history.
- Multi-hour chats rely on pi's compaction (tool-result pruning included).

## Not built (deliberately)

Skill packs, user modeling, multiple chat platforms, job DSLs, account integrations beyond
MCP servers (use `pi-mcp-adapter` with community Google/M365 MCP servers). Whisper STT.
