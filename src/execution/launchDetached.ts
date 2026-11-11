import { spawn, type ChildProcess } from "node:child_process";

export interface LaunchDetachedOptions {
  command: string;
  args: string[];
  cwd: string;
}

export interface LaunchDetachedResult {
  launched: boolean;
  pid: number | null;
  error: string | null;
}

const SPAWN_ERROR_GRACE_MS = 50;

/**
 * Fire-and-forget launch for a GUI-opening command (e.g. `claude
 * --desktop`, `codex app`) — deliberately not `spawnRun.ts`: there is
 * nothing to wait for (a window just opens), so no timeout, no output
 * capture, no process-group kill. `detached: true` + `unref()` lets this
 * process exit without taking the launched app down with it. Waits one
 * short grace period for Node's own async spawn-error event (e.g. the
 * binary not existing on PATH) before reporting success — without it,
 * a missing CLI would be reported "launched" even though nothing opened.
 */
export function launchDetached(options: LaunchDetachedOptions, spawnImpl: typeof spawn = spawn): Promise<LaunchDetachedResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(options.command, options.args, { cwd: options.cwd, stdio: "ignore", detached: true });
    } catch (err) {
      resolve({ launched: false, pid: null, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let spawnError: string | null = null;
    child.once("error", (err) => {
      spawnError = err.message;
    });
    const pid = child.pid ?? null;
    child.unref();
    setTimeout(() => resolve({ launched: !spawnError, pid, error: spawnError }), SPAWN_ERROR_GRACE_MS);
  });
}
