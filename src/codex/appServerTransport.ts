import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Transport for the `codex app-server` JSON-RPC protocol, as verified live
 * on this machine (see docs/FEASIBILITY.md, Phase 1A):
 *
 *   - Wire framing: newline-delimited JSON (NOT LSP-style Content-Length).
 *   - Handshake: client sends `initialize` (id+method+params), waits for
 *     its result, then sends an `initialized` notification (method only,
 *     no id) before any other request is answered.
 *   - A line with `id` (no further distinguishing needed in practice here)
 *     is a response to one of our requests; a line with `method` and no
 *     `id` is a server notification.
 *
 * The protocol also allows the *server* to send us requests (id+method),
 * e.g. approval prompts for a running turn. This client never issues a
 * turn, so none should arrive for the usage-read flow; if one ever does,
 * we log and ignore it rather than guess at a response — answering a
 * command-approval request we don't understand is a correctness and
 * safety risk, not a connectivity one.
 */
export interface CodexAppServerTransport {
  start(): Promise<void>;
  request<T>(method: string, params: unknown): Promise<T>;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
  close(): Promise<void>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 10_000;

export class ProcessCodexAppServerTransport implements CodexAppServerTransport {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private started = false;
  private closed = false;
  private fatalError: Error | undefined;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const proc = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;

    const onSpawnError = (err: Error & { code?: string }) => {
      this.fatalError =
        err.code === "ENOENT"
          ? new Error("`codex` CLI was not found on PATH — is Codex CLI installed?")
          : err;
      this.rejectAllPending(this.fatalError);
    };
    proc.once("error", onSpawnError);

    proc.once("exit", (code, signal) => {
      if (this.closed) return;
      const err = new Error(`codex app-server exited early (code=${code}, signal=${signal})`);
      this.fatalError = err;
      this.rejectAllPending(err);
    });

    createInterface({ input: proc.stdout }).on("line", (line) => this.handleLine(line));

    // Diagnostic logging only; codex logs config warnings etc. here on
    // every run and that is not itself a failure.
    proc.stderr.setEncoding("utf8");

    await this.rpcRequest<{ codexHome?: string }>("initialize", {
      clientInfo: { name: "agent-relay", title: "agent-relay", version: "0.1.0" },
    });
    this.notify("initialized");
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // not a protocol line (e.g. stray log output); ignore rather than crash
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const obj = parsed as { id?: number; method?: string; result?: unknown; error?: { message?: string }; params?: unknown };

    if (typeof obj.id === "number" && !obj.method) {
      const pending = this.pending.get(obj.id);
      if (!pending) return;
      this.pending.delete(obj.id);
      clearTimeout(pending.timer);
      if (obj.error) {
        pending.reject(new Error(obj.error.message ?? "app-server returned an error response"));
      } else {
        pending.resolve(obj.result);
      }
      return;
    }

    if (typeof obj.method === "string" && typeof obj.id !== "number") {
      const handlers = this.notificationHandlers.get(obj.method);
      handlers?.forEach((handler) => handler(obj.params));
    }
    // A line with both `id` and `method` is a server->client request; see
    // the class-level doc comment for why we deliberately don't answer it.
  }

  private rpcRequest<T>(method: string, params: unknown): Promise<T> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error("transport not started"));

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server did not respond to "${method}" within ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    if (!this.started) await this.start();
    return this.rpcRequest<T>(method, params);
  }

  private notify(method: string, params?: unknown): void {
    this.proc?.stdin.write(JSON.stringify(params === undefined ? { method } : { method, params }) + "\n");
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const set = this.notificationHandlers.get(method) ?? new Set();
    set.add(handler);
    this.notificationHandlers.set(method, set);
    return () => set.delete(handler);
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectAllPending(new Error("transport closed"));
    this.proc?.stdin.end();
    this.proc?.kill();
  }
}
