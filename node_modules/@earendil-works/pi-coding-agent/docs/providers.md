# Providers

Pi ships with a default set of providers focused on European cloud inference and local models: **GreenPT** and **Viro AI** (OpenAI-compatible cloud APIs), plus **LM Studio**, **Ollama**, **vLLM**, and **llama.cpp server** for local inference. Other built-in providers (Anthropic, OpenAI, Google, etc.) remain in the provider catalog but are not registered by pi by default; see [Other Built-in Providers](#other-built-in-providers).

## Table of Contents

- [Default Providers](#default-providers)
- [Other Built-in Providers](#other-built-in-providers)
- [API Keys and Auth File](#api-keys-and-auth-file)
- [llama.cpp](#llamacpp)
- [Custom Providers](#custom-providers)
- [Resolution Order](#resolution-order)

## Default Providers

These providers are offered by `/login`, `/model`, and first-run setup. All of them speak the OpenAI Completions API.

### GreenPT

European OpenAI-compatible API ([docs.greenpt.ai](https://docs.greenpt.ai)) with a curated catalog (GLM, Kimi, DeepSeek, Qwen, MiniMax, Gemma, GPT-OSS, and GreenPT's own models).

```bash
export GREENPT_API_KEY=...
# or: /login greenpt
pi --provider greenpt --model glm-5.2
```

### Viro AI

OpenAI-compatible API at `https://ai.viro.app/api`. Models are discovered dynamically from the server (`GET /models`).

```bash
export VIRO_API_KEY=...
# or: /login viro
pi --provider viro
```

### Local Inference Servers

On first interactive startup, pi offers to set up llama.cpp as the default local provider: it installs a pinned `llama-server`, starts it on `http://127.0.0.1:8080` (`LLAMA_BASE_URL` overrides), downloads the default model, and saves it as the startup default. See [llama-cpp.md](llama-cpp.md).

LM Studio, Ollama, vLLM, and a bring-your-own llama.cpp server run locally and need no API key (optional env vars are supported). Pi discovers their models from the OpenAI-compatible `GET /models` endpoint at startup.

| Provider | Default endpoint | Optional key env var |
|----------|------------------|----------------------|
| LM Studio | `http://localhost:1234/v1` | `LMSTUDIO_API_KEY` |
| Ollama | `http://localhost:11434/v1` | `OLLAMA_API_KEY` |
| vLLM | `http://localhost:8000/v1` | `VLLM_API_KEY` |
| llama.cpp server | `http://localhost:8080/v1` | `LLAMA_CPP_API_KEY` |

Start the server, then:

```bash
pi --provider lmstudio      # or ollama / vllm / llama-cpp
```

Discovered models assume a 128k context window and 8k output; override per model with `models.json` `modelOverrides` (see [models.md](models.md)).

## Other Built-in Providers

The provider catalog also contains cloud API-key and subscription providers (Anthropic, OpenAI, Google, Amazon Bedrock, Groq, xAI, OpenRouter, and many more). They are not registered by pi's default runtime, but remain available:

- **Via `models.json`:** declare the provider as a custom provider with its `baseUrl` and API (see [models.md](models.md)). Environment variables and `auth.json` keys are listed in [`packages/ai/src/env-api-keys.ts`](../../ai/src/env-api-keys.ts).
- **Via the SDK:** `ModelRuntime.create({ allBuiltinProviders: true })` registers the full catalog.

Subscription OAuth providers (ChatGPT/Codex, Claude Pro/Max, GitHub Copilot, xAI, OpenRouter, Radius) are not offered by `/login` in the default runtime.

## API Keys and Auth File

API keys are resolved from the credential store (`~/.pi/agent/auth.json`) or environment variables. Store a key via `/login <provider>` or set the env var directly:

```bash
export GREENPT_API_KEY=...
# or: export VIRO_API_KEY=...
```

| Provider | Environment Variable | `auth.json` key |
|----------|----------------------|------------------|
| GreenPT | `GREENPT_API_KEY` | `greenpt` |
| Viro AI | `VIRO_API_KEY` | `viro` |

Store credentials in `~/.pi/agent/auth.json`:

```json
{
  "greenpt": { "type": "api_key", "key": "..." },
  "viro": { "type": "api_key", "key": "..." }
}
```

The file is created with `0600` permissions (user read/write only). Auth file credentials take priority over environment variables.

API key credentials can also include provider-scoped environment values. These values are used before process environment variables when resolving the credential key, provider/model headers, and provider configuration such as `PI_CACHE_RETENTION` and `HTTP_PROXY`/`HTTPS_PROXY`.

```json
{
  "greenpt": {
    "type": "api_key",
    "key": "$GREENPT_API_KEY",
    "env": {
      "GREENPT_API_KEY": "..."
    }
  }
}
```

Use this when pi should use different provider settings than the project shell environment.

### Key Resolution

The `key` field supports command execution, environment interpolation, and literals:

- **Shell command:** `"!command"` at the start executes the whole value as a command and uses stdout (cached for process lifetime)
  ```json
  { "type": "api_key", "key": "!security find-generic-password -ws 'greenpt'" }
  ```
- **Environment interpolation:** `"$ENV_VAR"` or `"${ENV_VAR}"` uses the value of the named variable. Interpolation works inside larger literals.
  ```json
  { "type": "api_key", "key": "$MY_GREENPT_KEY" }
  { "type": "api_key", "key": "${KEY_PREFIX}_${KEY_SUFFIX}" }
  ```
  `$FOO_BAR` is the variable `FOO_BAR`; use `${FOO}_BAR` when `BAR` is literal text. Missing environment variables make the value unresolved.
- **Escapes:** `"$$"` emits a literal `"$"`; `"$!"` emits a literal `"!"` without triggering command execution.
  ```json
  { "type": "api_key", "key": "$$literal-dollar-prefix" }
  { "type": "api_key", "key": "$!literal-bang-prefix" }
  ```
- **Literal value:** Used directly. Plain uppercase strings such as `MY_API_KEY` are literals; use `$MY_API_KEY` for environment variables.
  ```json
  { "type": "api_key", "key": "..." }
  { "type": "api_key", "key": "public" }
  ```

OAuth credentials are stored here after `/login` for providers that use OAuth.

## llama.cpp

Pi supports the llama.cpp router server. Configure it with `/login llama.cpp`, manage loaded models with `/llama`, and select a loaded model with `/model`.

See [llama.cpp](llama-cpp.md) for server setup, model directory layout, environment variables, and command usage.

## Custom Providers

**Via models.json:** Add Ollama, LM Studio, vLLM, or any provider that speaks a supported API (OpenAI Completions, OpenAI Responses, Anthropic Messages, Google Generative AI). See [models.md](models.md).

**Via extensions:** For providers that need custom API implementations or OAuth flows, create an extension. See [custom-provider.md](custom-provider.md) and [examples/extensions/custom-provider-gitlab-duo](../examples/extensions/custom-provider-gitlab-duo/).

## Resolution Order

When resolving credentials for a provider:

1. CLI `--api-key` flag
2. `auth.json` entry (API key or OAuth token)
3. Environment variable
4. Custom provider keys from `models.json`
