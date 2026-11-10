import { createServer, type Server } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { encodeMessage, parseRequest, type DaemonResponse } from "./protocol.js";

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

  async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await rm(this.socketPath, { force: true });

    this.server = createServer((socket) => {
      const rl = createInterface({ input: socket });
      rl.on("line", (line) => {
        void this.handleLine(socket, line);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, resolve);
    });
    await chmod(this.socketPath, 0o600);
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
