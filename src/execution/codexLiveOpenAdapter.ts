import { spawnRun } from "./spawnRun.js";
import { launchDetached } from "./launchDetached.js";
import type { LiveOpenAdapter, LiveOpenOptions, LiveOpenResult } from "./types.js";

/**
 * Codex has no single command that both opens the Desktop app and seeds
 * an initial message. Instead (see docs/LIVE_HANDOFF.md):
 *  - with a known `resumeSessionId`: `codex queue --thread <id> --message
 *    <instruction>` pushes the instruction into that existing thread
 *    (quick, headless, capturable exit code — queuing is a one-shot
 *    operation, not a GUI launch), then
 *  - `codex app <cwd>` always fires afterward, fire-and-forget, to bring
 *    the Desktop app forward for this workspace.
 * With no `resumeSessionId`, only `codex app <cwd>` fires — the
 * instruction is not seeded, and `detail` says so plainly rather than
 * silently dropping it.
 */
export class CodexLiveOpenAdapter implements LiveOpenAdapter {
  readonly provider = "codex" as const;

  constructor(
    private readonly launch: typeof launchDetached = launchDetached,
    private readonly runQueue: typeof spawnRun = spawnRun,
  ) {}

  async open(options: LiveOpenOptions): Promise<LiveOpenResult> {
    const appCommand = ["codex", "app", options.cwd];
    if (!options.resumeSessionId) {
      const appResult = await this.launch({ command: "codex", args: ["app", options.cwd], cwd: options.cwd });
      return {
        launched: appResult.launched,
        command: appCommand,
        sessionId: null,
        detail: appResult.launched
          ? "launched `codex app` with no existing thread to resume — the instruction was NOT seeded; paste it manually once a session is started"
          : `failed to launch codex app: ${appResult.error ?? "unknown error"}`,
      };
    }

    const queueArgs = ["queue", "--thread", options.resumeSessionId, "--message", options.instruction];
    const queueCommand = ["codex", ...queueArgs];
    const queueResult = await this.runQueue({ command: "codex", args: queueArgs, cwd: options.cwd });
    if (queueResult.exitCode !== 0) {
      return {
        launched: false,
        command: queueCommand,
        sessionId: options.resumeSessionId,
        detail: `codex queue exited with code ${queueResult.exitCode ?? "null"}: ${queueResult.stderr.trim() || "no stderr output"}`,
      };
    }

    const appResult = await this.launch({ command: "codex", args: ["app", options.cwd], cwd: options.cwd });
    return {
      launched: appResult.launched,
      command: [...queueCommand, "&&", ...appCommand],
      sessionId: options.resumeSessionId,
      detail: appResult.launched ? "queued the instruction into the existing thread and launched `codex app`" : `queued the instruction, but failed to launch codex app: ${appResult.error ?? "unknown error"}`,
    };
  }
}
