import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { encodeMessage, parseResponse } from "./protocol.js";

export class DaemonUnreachableError extends Error {}
export class DaemonTimeoutError extends Error {}
export class DaemonCommandError extends Error {}

/**
 * Requirement #3's client half: one request, one response, over the Unix
 * socket at `socketPath`. Always closes the connection, whatever
 * happened. A connection failure (`ENOENT`/`ECONNREFUSED` — no daemon
 * running, or a stale socket file) is distinguished from a request that
 * the daemon genuinely rejected, so callers (the CLI's fallback logic,
 * §4) can tell "no daemon" apart from "daemon said no".
 */
export function callDaemon(socketPath: string, command: string, args: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const id = randomUUID();

  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      socket.destroy();
      fn();
    };

    const timeoutHandle = setTimeout(() => finish(() => reject(new DaemonTimeoutError(`daemon did not respond to "${command}" within ${timeoutMs}ms`))), timeoutMs);

    socket.once("error", (err: NodeJS.ErrnoException) => {
      finish(() => reject(new DaemonUnreachableError(err.code === "ENOENT" || err.code === "ECONNREFUSED" ? "no daemon is listening on this socket" : err.message)));
    });

    socket.once("connect", () => {
      socket.write(encodeMessage({ id, command, args }));
      const rl = createInterface({ input: socket });
      rl.on("line", (line) => {
        const parsed = parseResponse(line);
        if ("error" in parsed) return; // ignore garbage, keep waiting for a well-formed line up to the timeout
        if (parsed.response.id !== id) return; // a response to some other request on a reused connection — never happens here (one request per connection), but never misattribute if it did
        finish(() => (parsed.response.ok ? resolve(parsed.response.result) : reject(new DaemonCommandError(parsed.response.error))));
      });
    });
  });
}

export interface PingResult {
  pid: number;
  uptimeMs: number;
  version: string;
}

/** The single-instance guard and `daemon status` both use this: a real response means a daemon genuinely owns this socket; any connection failure means it's safe to treat as not running. */
export async function pingDaemon(socketPath: string, timeoutMs = 2_000): Promise<PingResult | null> {
  try {
    return (await callDaemon(socketPath, "ping", {}, { timeoutMs })) as PingResult;
  } catch (err) {
    if (err instanceof DaemonUnreachableError || err instanceof DaemonTimeoutError) return null;
    throw err;
  }
}
