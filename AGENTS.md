# Repository Instructions

## What this repo is

Local OpenCode-compatible HTTP proxy that adapts OpenAI-style chat requests into Cursor Composer's SDK protocol. One Node process serves:

- OpenCode routes (`/opencodev2/v1/*`, legacy `/opencode/v1/*`)
- Internal Cursor SDK HTTP/2 bridge (`/sdk`, used by `worker/cursor-sdk.ts`)

**Use `/opencodev2/v1` for tool-heavy work.** Legacy `/opencode/v1` uses a different Cursor chat protocol (`worker/cursor.ts`).

Tool compatibility tables and user-facing setup live in `README.md`. Read that before changing adapter behavior.

## Layout

| Path | Role |
|---|---|
| `worker/routes.ts` | HTTP routing; `handleRequest()` is the main entry |
| `worker/openai.ts` | OpenAI request prep, tool filtering, transcript building |
| `worker/cursor-sdk.ts` | SDK protobuf decode/encode, tool-call mapping |
| `worker/cursor.ts` | Legacy chat-endpoint adapter |
| `scripts/opencode-local-server.ts` | Local dev server (`pnpm start`) |
| `scripts/cursor-sdk-opencode-bridge.mjs` | HTTP/2 bridge to Cursor backend |
| `scripts/opencode-run.ts` | Timeout wrapper for OpenCode CLI |
| `scripts/test-opencode-websearch.sh` | Live integration smoke test |

`tsconfig.json` typechecks `worker/` and `vitest.config.ts` only. `scripts/` is not in the TS project — run `pnpm typecheck` but also verify script changes manually.

## Setup and run

```bash
pnpm install
cp .env.example .env   # fill CURSOR_BACKEND_BASE_URL, CURSOR_LOCAL_AGENT_ENDPOINT
pnpm start             # http://127.0.0.1:8787, OpenCode base: /opencodev2/v1
```

- `.env` is loaded by `scripts/opencode-local-server.ts` via `loadLocalEnvFiles()`.
- `CURSOR_API_KEY` is client-side (OpenCode Bearer token), not stored in `.env`.
- Nix shell available: `direnv allow` (`.envrc` → `flake.nix` provides `pnpm`).

## Verify changes

Default order for code changes:

```bash
pnpm typecheck
pnpm test
```

- Unit tests: `vitest run`, scoped to `worker/**/*.test.ts` (10s timeout each).
- Single file: `pnpm exec vitest run worker/cursor-sdk.test.ts`
- Watch mode: `pnpm test:watch`

Live integration (needs running server + `CURSOR_API_KEY`):

```bash
pnpm start   # separate terminal
pnpm test:opencode
```

`pnpm test:opencode` hits `/health`, calls `/opencodev2/v1/chat/completions` directly, then runs OpenCode CLI via `scripts/opencode-run.ts`. Increase `OPENCODE_RUN_TIMEOUT_MS` / `CURL_TEST_TIMEOUT_SEC` for slow runs.

Docker: `docker compose up -d --build` (healthcheck on `/health`).

## Architecture notes agents miss

1. **Composer does not call OpenCode tools directly.** OpenCode sends a tool list; this server embeds it in a text transcript. Composer emits Cursor SDK protobuf tool calls; the adapter converts matching calls back to OpenAI `tool_calls` for OpenCode to execute locally.

2. **Tool filtering is intentional.** `worker/openai.ts` `SDK_CALLABLE_TOOL_NAMES` + `filterSdkCallableTools()` strip OpenCode-only tools (e.g. `skill`, `lsp`, `apply_patch`, custom plugin tools) before the prompt reaches Cursor. Do not "fix" missing tools by only updating README — check both `openai.ts` and `cursor-sdk.ts` mappings.

3. **`websearch` / `webfetch` are Cursor-hosted in the SDK harness.** The adapter always advertises them; Cursor executes search/fetch and injects result records. OpenCode's native websearch providers are not used through this proxy.

4. **New files via streaming edit normalize to `write`.** See `worker/cursor-sdk.ts` edit→write handling and tests in `worker/openai.test.ts`.

5. **Stalled runs fail with 504**, not infinite hang — tune `CURSOR_SDK_*_TIMEOUT_MS` and `COMPOSER_API_REQUEST_TIMEOUT_MS` in `.env.example`.

6. **No CI workflows** in this repo. Local `pnpm typecheck && pnpm test` is the gate before PR.

## Conventions

- Conventional Commits: `<type>: <summary>` (factual, neutral).
- Strict TypeScript in `worker/` — no `@ts-ignore`, no `as any`.
- Package manager: `pnpm@10.12.1` (see `packageManager` in `package.json`).
- When adding SDK tool mappings, update **both** `worker/cursor-sdk.ts` (`TOOL_CALL_SPECS` / decode) and `worker/openai.ts` (`SDK_CALLABLE_TOOL_NAMES`), plus tests in `worker/cursor-sdk.test.ts` and/or `worker/openai.test.ts`.

## Secrets and git

- Do not commit private Cursor backend origins, endpoint paths, or service names. Keep them in local `.env` only.
- Do not commit `.env`, `.dev.vars`, or API keys.
- Before force-pushing rewritten history, scan all reachable commits for private endpoint strings.
