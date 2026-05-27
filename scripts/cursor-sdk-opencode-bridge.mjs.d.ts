import type { IncomingMessage, ServerResponse } from "node:http";

export function loadLocalEnvFiles(): void;
export function closeBridgeHttp2Clients(): void;
export function handleBridgeHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options?: { host?: string; port?: number }
): Promise<void>;
