/**
 * Requirement #3's local control protocol wire format: one JSON object
 * per line (same convention this project already uses for the Codex
 * app-server transport — see src/codex/appServerTransport.ts — no
 * length-prefix framing).
 */
export interface DaemonRequest {
  id: string;
  command: string;
  args: unknown;
}

export type DaemonResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

export function encodeMessage(message: DaemonRequest | DaemonResponse): string {
  return `${JSON.stringify(message)}\n`;
}

/** Never throws — a malformed line is reported as a parse failure, not an exception, since both the client and the server must survive garbage on the wire. */
export function parseRequest(line: string): { request: DaemonRequest } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: "request was not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "request was not a JSON object" };
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id) return { error: "request is missing a string `id`" };
  if (typeof obj.command !== "string" || !obj.command) return { error: "request is missing a string `command`" };
  return { request: { id: obj.id, command: obj.command, args: obj.args } };
}

export function parseResponse(line: string): { response: DaemonResponse } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: "response was not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "response was not a JSON object" };
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id) return { error: "response is missing a string `id`" };
  if (obj.ok === true) return { response: { id: obj.id, ok: true, result: obj.result } };
  if (obj.ok === false && typeof obj.error === "string") return { response: { id: obj.id, ok: false, error: obj.error } };
  return { error: "response is missing a valid `ok`/`error` shape" };
}
