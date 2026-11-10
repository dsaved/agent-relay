import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LogEventKind =
  | "task_lifecycle"
  | "agent_execution"
  | "subscription_exhaustion"
  | "provider_handoff"
  | "workspace_ownership"
  | "approval_required"
  | "daemon_startup"
  | "daemon_shutdown"
  | "crash_recovery"
  | "validation_result";

const SENSITIVE_KEY_RE = /token|secret|password|api[_-]?key/i;

/** Requirement #9: strips any object key that looks like a credential before it's ever written — applied recursively since a logged payload (e.g. an execution env) can nest arbitrarily. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

export function logPath(stateDir: string, date: Date = new Date()): string {
  return join(stateDir, "logs", `daemon-${date.toISOString().slice(0, 10)}.jsonl`);
}

/**
 * Structured, append-only JSONL logging (requirement #9). One line per
 * event; a task's `events`/raw conversation is never dumped by
 * default — callers pass counts/outcomes, not full transcripts (see
 * `DaemonLogger.execution`'s doc comment).
 */
export class DaemonLogger {
  constructor(private readonly stateDir: string) {}

  async write(kind: LogEventKind, data: object): Promise<void> {
    const path = logPath(this.stateDir);
    await mkdir(dirname(path), { recursive: true });
    const line = JSON.stringify({ at: Date.now(), kind, ...(redact(data) as Record<string, unknown>) });
    await appendFile(path, `${line}\n`);
  }

  /** Deletes log files older than `retentionDays` — never the current day's file, regardless of the configured retention. */
  async rotate(retentionDays: number): Promise<void> {
    const logsDir = join(this.stateDir, "logs");
    let names: string[];
    try {
      names = await readdir(logsDir);
    } catch {
      return;
    }
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
    for (const name of names) {
      const path = join(logsDir, name);
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff) await rm(path, { force: true });
      } catch {
        // a file disappearing mid-rotation is not a failure worth stopping over
      }
    }
  }
}
