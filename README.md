# Composer API

Local OpenCode-compatible API proxy for Cursor Composer.

## Quick start

```bash
pnpm install
cp .env.example .env
export CURSOR_API_KEY="crsr_..."
pnpm start
```

The server listens on `http://127.0.0.1:8787`. OpenCode base URL:

```txt
http://127.0.0.1:8787/opencodev2/v1
```

Add a custom provider to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "cursor": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Cursor Composer 2.5",
      "options": {
        "baseURL": "http://127.0.0.1:8787/opencodev2/v1",
        "apiKey": "${CURSOR_API_KEY}"
      },
      "models": {
        "composer-2.5-sdk": {
          "name": "Composer 2.5 SDK Harness"
        }
      }
    }
  }
}
```

Then run OpenCode with your Cursor API key in the environment:

```bash
export CURSOR_API_KEY="crsr_..."
opencode
```

## What this is

This project exposes OpenCode routes that adapt OpenAI-style requests into Cursor's local-agent SDK protocol. OpenCode owns local filesystem and shell execution; the server translates SDK tool-call events back into OpenAI-compatible `tool_calls`.

One Node process handles everything:

- OpenCode HTTP API (`/opencodev2/v1/*`)
- Cursor SDK HTTP/2 bridge (internal `/sdk` route)

## Supported endpoints

Recommended SDK harness:

- `GET /opencodev2/v1/models`
- `POST /opencodev2/v1/chat/completions`

Legacy Cursor chat-endpoint route:

- `GET /opencode/v1/models`
- `POST /opencode/v1/chat/completions`

Authenticate every request with your Cursor API key as a Bearer token. The key is forwarded to Cursor per request and is not stored.

## Environment variables

Create `.env` from `.env.example`:

| Variable | Required | Purpose |
|---|---|---|
| `CURSOR_BACKEND_BASE_URL` | yes | Cursor backend origin (e.g. `https://api2.cursor.sh`) |
| `CURSOR_LOCAL_AGENT_ENDPOINT` | yes | SDK RPC path (e.g. `/agent.v1.AgentService/Run`) |
| `CURSOR_CHAT_ENDPOINT` | for `/opencode/v1` | Legacy chat RPC path |
| `COMPOSER_API_HOST` | no | Bind address (default `127.0.0.1`) |
| `COMPOSER_API_PORT` | no | Listen port (default `8787`) |

Client-side: OpenCode uses `CURSOR_API_KEY` as Bearer token (not stored in `.env`).

## Development

```bash
pnpm test
pnpm run typecheck
```
