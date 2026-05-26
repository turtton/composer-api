import type { Env } from "./types";

export async function exchangeCursorApiKey(env: Env, apiKey: string): Promise<string> {
  const base = env.CURSOR_BACKEND_BASE_URL;
  if (!base) throw new Error("CURSOR_BACKEND_BASE_URL is not configured");
  const url = `${base.replace(/\/$/, "")}/auth/exchange_user_api_key`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: "{}"
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401) throw new Error("Invalid Cursor API key");
    throw new Error(text || `Cursor auth failed with status ${response.status}`);
  }
  const payload = (await response.json()) as { accessToken?: string };
  if (!payload.accessToken) throw new Error("Cursor did not return an access token");
  return payload.accessToken;
}
