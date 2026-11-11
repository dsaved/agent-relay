import { createServer, type Server } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { encodeMessage, parseRequest, type DaemonResponse } from "./protocol.js";
import { pingDaemon } from "./client.js";

export type CommandHandler = (args: unknown) => Promise<unknown>;

/**
 * Requirement #3's local control protocol server: a Unix domain socket,
 * restricted to this user (`0700` directory, `0600` socket file — set
 * right after `listen()`, the same restrictive-permissions discipline
 * this project already applies to its lock/store files), newline-
 * delimited JSON, one dispatch table of named commands. No TCP listener
 * exists anywhere in this file.
 */
export class DaemonSocketServer {
  private server: Server | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly handlers: Record<string, CommandHandler>,
  ) {}

  /**
   * Operational-hardening fix #2: two processes racing to start a daemon
   * for the same state directory could previously both pass a
   * check-then-`rm()`-then-`listen()` sequence that was not itself
   * atomic — each might delete the *other's* just-created live socket
   * file before binding its own. Fixed by making the bind attempt itself
   * the atomic guard: `listen()` is tried first (a stale or live file at
   * the path makes it fail with `EADDRINUSE`, same as any POSIX bind
   * would), and only *after* that failure is the file's liveness checked
   * — if something really answers, this call fails loudly rather than
   * stealing a live daemon's socket; only a confirmed-stale file is
   * removed, and then exactly one retry is made.
   */
  async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });

    this.server = createServer((socket) => {
      const rl = createInterface({ input: socket });
      rl.on("line", (line) => {
        void this.handleLine(socket, line);
      });
    });

    try {
      await this.listenOnce();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      if (await pingDaemon(this.socketPath, 1_000)) throw err; // a real daemon answers there — never steal its socket
      await rm(this.socketPath, { force: true }); // confirmed stale — safe to reclaim
      await this.listenOnce();
    }
    await chmod(this.socketPath, 0o600);
  }

  private listenOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, resolve);
    });
  }

  private async handleLine(socket: { write: (data: string) => void }, line: string): Promise<void> {
    if (!line.trim()) return;
    const parsed = parseRequest(line);
    if ("error" in parsed) {
      // No request id to reply under — nothing safe to send back; drop it, same as any other garbage-on-the-wire case this project already treats as non-fatal.
      return;
    }
    const { id, command, args } = parsed.request;
    const handler = this.handlers[command];
    let response: DaemonResponse;
    if (!handler) {
      response = { id, ok: false, error: `unknown command "${command}"` };
    } else {
      try {
        response = { id, ok: true, result: await handler(args) };
      } catch (err) {
        response = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    socket.write(encodeMessage(response));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    await rm(this.socketPath, { force: true });
    this.server = null;
  }
}
