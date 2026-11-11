import { launchDetached } from "./launchDetached.js";
import type { LiveOpenAdapter, LiveOpenOptions, LiveOpenResult } from "./types.js";

/**
 * `claude --desktop [--resume <id>] "<instruction>"` opens the real
 * Claude Desktop app window on the given (or a brand-new) session —
 * confirmed from this machine's real `claude --help` (see
 * docs/LIVE_HANDOFF.md). Exact behavior combining `--desktop` with a
 * prompt and `--resume` together is UNVERIFIED pending a separate, live
 * check — this adapter only builds and fires the documented command.
 */
export class ClaudeLiveOpenAdapter implements LiveOpenAdapter {
  readonly provider = "claude" as const;

  constructor(private readonly launch: typeof launchDetached = launchDetached) {}

  async open(options: LiveOpenOptions): Promise<LiveOpenResult> {
    const args = ["--desktop", ...(options.resumeSessionId ? ["--resume", options.resumeSessionId] : []), options.instruction];
    const command = ["claude", ...args];
    const result = await this.launch({ command: "claude", args, cwd: options.cwd });
    return {
      launched: result.launched,
      command,
      sessionId: options.resumeSessionId ?? null,
      detail: result.launched ? "launched `claude --desktop` — check the Claude Desktop app window" : `failed to launch claude: ${result.error ?? "unknown error"}`,
    };
  }
}
