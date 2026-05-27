import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { closeBridgeHttp2Clients, handleBridgeHttpRequest, loadLocalEnvFiles } from "./cursor-sdk-opencode-bridge.mjs";
import { toWebRequest, writeWebResponse } from "./node-http";
import { handleRequest } from "../worker/routes";
import { fakeCtx } from "../worker/test-helpers";
import type { Env } from "../worker/types";

loadLocalEnvFiles();

const host = process.env.COMPOSER_API_HOST || "127.0.0.1";
const port = parsePort(process.env.COMPOSER_API_PORT, 8787);
const baseUrl = `http://${host}:${port}`;

const env = buildEnv(port);

const server = http.createServer((request, response) => {
  dispatch(request, response).catch((error) => {
    if (!response.headersSent) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
      return;
    }
    response.destroy(error instanceof Error ? error : new Error(String(error)));
  });
});

server.listen(port, host, () => {
  console.log(`Composer API listening on ${baseUrl}`);
  console.log(`OpenCode base URL: ${baseUrl}/opencodev2/v1`);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function dispatch(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url || "/", baseUrl);

  if (url.pathname === "/health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/sdk") {
    await handleBridgeHttpRequest(request, response, { host, port });
    return;
  }

  const webRequest = await toWebRequest(request, baseUrl);
  const webResponse = await handleRequest(webRequest, env, fakeCtx());
  await writeWebResponse(response, webResponse);
}

function buildEnv(listenPort: number): Env {
  return {
    CURSOR_API_BASE: process.env.CURSOR_API_BASE || "https://api.cursor.com",
    CURSOR_BACKEND_BASE_URL: requiredEnv("CURSOR_BACKEND_BASE_URL"),
    CURSOR_CHAT_ENDPOINT: process.env.CURSOR_CHAT_ENDPOINT,
    CURSOR_CLIENT_VERSION: process.env.CURSOR_CLIENT_VERSION || "2.6.22",
    CURSOR_LOCAL_AGENT_ENDPOINT: requiredEnv("CURSOR_LOCAL_AGENT_ENDPOINT"),
    CURSOR_SDK_BRIDGE_URL: `http://127.0.0.1:${listenPort}/sdk`,
    CURSOR_SDK_BRIDGE_TOKEN: process.env.CURSOR_SDK_BRIDGE_TOKEN,
    CURSOR_SDK_CLIENT_VERSION: process.env.CURSOR_SDK_CLIENT_VERSION || "sdk-1.0.13"
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill in the values.`);
    process.exit(1);
  }
  return value;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function shutdown(code: number) {
  closeBridgeHttp2Clients();
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref();
}
