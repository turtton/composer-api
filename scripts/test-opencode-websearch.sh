#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

HOST="${COMPOSER_API_HOST:-127.0.0.1}"
PORT="${COMPOSER_API_PORT:-8787}"
BASE_URL="http://${HOST}:${PORT}"
API_URL="${BASE_URL}/opencodev2/v1/chat/completions"
MODEL="${TEST_MODEL:-composer-2.5-fast}"
CURL_TIMEOUT="${CURL_TEST_TIMEOUT_SEC:-120}"
OPENCODE_TIMEOUT_MS="${OPENCODE_RUN_TIMEOUT_MS:-180000}"

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "CURSOR_API_KEY is required (export it or add to .env)" >&2
  exit 1
fi

echo "== health =="
curl -sS --max-time 5 "${BASE_URL%/}/health" | head -c 200
echo

echo
echo "== direct API (websearch prompt, curl timeout ${CURL_TIMEOUT}s) =="
API_OUT="$(mktemp)"
set +e
curl -sS --max-time "${CURL_TIMEOUT}" "${API_URL}" \
  -H "Authorization: Bearer ${CURSOR_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg model "$MODEL" '{
    model: $model,
    stream: false,
    messages: [{
      role: "user",
      content: "Use websearch only. Query: Astro framework adoption 2026. Reply in one English sentence summarizing search results. If websearch is unavailable, say so explicitly."
    }],
    tools: [{
      type: "function",
      function: {
        name: "bash",
        description: "shell",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"]
        }
      }
    }]
  }')" >"${API_OUT}" 2>&1
CURL_EXIT=$?
set -e

if [[ "${CURL_EXIT}" -eq 28 ]]; then
  echo "curl timed out after ${CURL_TIMEOUT}s"
elif [[ "${CURL_EXIT}" -ne 0 ]]; then
  echo "curl failed (exit ${CURL_EXIT})"
fi

if command -v jq >/dev/null 2>&1; then
  jq -r '.choices[0].message.content // .choices[0].message.tool_calls[0].function.name // .error.message // .' "${API_OUT}" 2>/dev/null || cat "${API_OUT}"
else
  cat "${API_OUT}"
fi
rm -f "${API_OUT}"

echo
echo "== opencode run (timeout ${OPENCODE_TIMEOUT_MS}ms) =="
OPENCODE_OUT="$(mktemp)"
set +e
OPENCODE_NO_SANDBOX=1 OPENCODE_RUN_TIMEOUT_MS="${OPENCODE_TIMEOUT_MS}" ./node_modules/.bin/tsx scripts/opencode-run.ts --timeout-ms "${OPENCODE_TIMEOUT_MS}" -- run \
  --format json \
  "2026年時点で新しさと採用の伸びが目立つフロントエンド枠組みを websearch だけで調べて、Astro / SvelteKit / SolidStart / Qwik / TanStack Start について1行ずつ答えて。websearch が使えないならその旨を書いて。" \
  --model "cursor-api/${MODEL}" >"${OPENCODE_OUT}" 2>&1
OPENCODE_EXIT=$?
set -e

if [[ "${OPENCODE_EXIT}" -eq 124 ]]; then
  echo "opencode timed out (exit ${OPENCODE_EXIT})"
elif [[ "${OPENCODE_EXIT}" -ne 0 ]]; then
  echo "opencode failed (exit ${OPENCODE_EXIT})"
fi

if command -v jq >/dev/null 2>&1; then
  jq -r 'select(.type == "text") | .part.text' "${OPENCODE_OUT}" | tail -20
else
  tail -40 "${OPENCODE_OUT}"
fi
rm -f "${OPENCODE_OUT}"
exit "${OPENCODE_EXIT}"
