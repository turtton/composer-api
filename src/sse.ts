const encoder = new TextEncoder();

export function encodeSse(data: unknown, event?: string): Uint8Array {
  const lines: string[] = [];
  if (event) lines.push(`event: ${event}`);
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  for (const line of payload.split("\n")) {
    lines.push(`data: ${line}`);
  }
  lines.push("", "");
  return encoder.encode(lines.join("\n"));
}
