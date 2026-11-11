import { spawn, type ChildProcess } from "node:child_process";

export interface LaunchDetachedOptions {
  command: string;
  args: string[];
  cwd: string;
}

export interface LaunchDetachedResult {
  launched: boolean;
  pid: number | null;
  /** A real spawn failure (e.g. the binary not existing on PATH) — null when the process started. */
  error: string | null;
}

const SPAWN_ERROR_GRACE_MS = 500;

/**
 * Fire-and-forget launch for a GUI-opening command (e.g. `claude
 * --desktop`, `codex app`) — deliberately not `spawnRun.ts`: there is
 * nothing to wait for (a window just opens), so no timeout-driven kill,
 * no process-group signaling.
 *
 * **`stdio: "inherit"`, not piped, not ignored — live-confirmed twice**:
 * piping stdout/stderr to capture them (an earlier version of this file)
 * surfaced the real reason nothing opened: `claude --desktop` refuses to
 * run at all when its own stdio looks redirected ("--desktop opens the
 * Claude Desktop app and can't run non-interactively (`--print`,
 * `--sdk-url`, `--init-only`, or redirected output)"). Inheriting this
 * process's own stdio keeps the child's streams genuinely attached to
 * the real terminal `agent-relay` itself was run from, which is what
 * satisfies that check — any output or error the command prints goes
 * straight to the person's terminal in real time, which is strictly
 * better here than being relayed through a captured string. `unref()`
 * alone is enough to let this process exit without waiting on the
 * child; inherited file descriptors stay open for the child regardless.
 */
export function launchDetached(options: LaunchDetachedOptions, spawnImpl: typeof spawn = spawn): Promise<LaunchDetachedResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(options.command, options.args, { cwd: options.cwd, stdio: "inherit" });
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
