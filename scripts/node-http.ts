import type { IncomingMessage, ServerResponse } from "node:http";

export async function readNodeBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function toWebRequest(request: IncomingMessage, baseUrl: string): Promise<Request> {
  const url = new URL(request.url || "/", baseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value !== "string") continue;
    headers.set(key, value);
  }
  const method = request.method || "GET";
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const raw = await readNodeBody(request);
    if (raw.length) body = new Uint8Array(raw);
  }
  return new Request(url, { method, headers, body });
}

export async function writeWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  const headerEntries = [...webResponse.headers.entries()];
  response.writeHead(webResponse.status, Object.fromEntries(headerEntries));
  if (!webResponse.body) {
    response.end();
    return;
  }
  const reader = webResponse.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(value);
    }
  } finally {
    reader.releaseLock();
  }
  response.end();
}
