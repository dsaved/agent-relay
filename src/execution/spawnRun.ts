import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ExecutionEvent } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MiB
const KILL_GRACE_MS = 5_000;

export interface SpawnRunOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Extra environment variables to layer on top of a copy of this process's own env — never a blank/unknown env, and never a place to inject secrets this tool doesn't itself hold. */
  env?: Record<string, string>;
}

export interface SpawnRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** One entry per stdout line that parsed as JSON; non-JSON lines are dropped, not fatal (see docs/HANDOFF_ENGINE.md on why). */
  events: ExecutionEvent[];
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  spawnError: Error | null;
}

/**
 * Signals an entire process group (POSIX only). The child is always
 * spawned `detached: true`, which on POSIX makes it the leader of its
 * own new process group — signaling `-pid` therefore reaches it and
 * every descendant that hasn't deliberately escaped the group (e.g. via
 * its own `setsid`), not just the one direct child. `ESRCH` means the
 * whole group is already gone, which is the success case, not an error.
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

/**
 * Runs one coding-agent CLI as a plain child process: an explicit
 * argument array (never a shell string — no injection surface), an
 * explicit cwd, a bounded, explicitly-constructed environment, a hard
 * output cap, an execution timeout, and SIGTERM-then-SIGKILL
 * termination of the *entire process group*, not just the direct child —
 * so a timed-out run can't leave descendants (e.g. a shell command the
 * agent itself started) still writing to the workspace after this
 * resolves. Never throws — a spawn failure, a timeout, and an output
 * overrun are all reported in the result, not as exceptions.
 */
export function spawnRun(options: SpawnRunOptions): Promise<SpawnRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const env = { ...process.env, ...(options.env ?? {}) };

  return new Promise((resolve) => {
    const events: ExecutionEvent[] = [];
    let stderr = "";
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let weInitiatedKill = false;

    const proc = spawn(options.command, options.args, { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });

    const terminate = (signal: NodeJS.Signals) => {
      weInitiatedKill = true;
      if (typeof proc.pid === "number") killGroup(proc.pid, signal);
      else proc.kill(signal);
    };

    const finish = (result: Omit<SpawnRunResult, "events" | "stderr" | "outputTruncated" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      // Belt-and-suspenders: if we're the reason this process ended, make
      // one more pass at the whole group before declaring it stopped —
      // the direct child reporting "exited" doesn't guarantee a
      // descendant that escaped the group did too, but this catches the
      // common case of stragglers still inside it.
      if (weInitiatedKill && typeof proc.pid === "number") killGroup(proc.pid, "SIGKILL");
      resolve({ ...result, events, stderr, outputTruncated, timedOut });
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      setTimeout(() => {
        if (!settled) terminate("SIGKILL");
      }, KILL_GRACE_MS);
    }, timeoutMs);

    proc.once("error", (err) => finish({ exitCode: null, signal: null, spawnError: err }));

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      if (outputTruncated) return;
      outputBytes += Buffer.byteLength(line, "utf8");
      if (outputBytes > maxOutputBytes) {
        outputTruncated = true;
        terminate("SIGTERM");
        return;
      }
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        events.push({ observedAt: Date.now(), raw: JSON.parse(trimmed) });
      } catch {
        // Not a JSON line (stray log output) — drop it, don't fail the run over it.
      }
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      if (stderr.length < maxOutputBytes) stderr += chunk;
    });

    proc.once("exit", (code, signal) => finish({ exitCode: code, signal, spawnError: null }));
  });
}
