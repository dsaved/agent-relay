import { launchDetached } from "./launchDetached.js";
import type { LiveOpenAdapter, LiveOpenOptions, LiveOpenResult } from "./types.js";

/**
 * `claude --desktop [--resume <id>]` opens the real Claude Desktop app
 * window on the given (or a brand-new) session. **Live-confirmed**: the
 * CLI flatly refuses a prompt argument together with `--desktop` —
 * `claude --desktop "x"` exits with "--desktop doesn't take a prompt
 * yet. Run `claude --desktop`, then type it in the app." So the
 * instruction is never seeded here; `LiveOpenResult.seeded` is always
 * false, and the caller (`openHandoffLive`) is responsible for showing
 * the instruction text for the person to paste in themselves. Also
 * live-confirmed: `--desktop` refuses to run at all with redirected
 * stdio — see `launchDetached.ts`'s doc comment for why this adapter's
 * launch is inherited, not captured.
 */
export class ClaudeLiveOpenAdapter implements LiveOpenAdapter {
  readonly provider = "claude" as const;

  constructor(private readonly launch: typeof launchDetached = launchDetached) {}

  async open(options: LiveOpenOptions): Promise<LiveOpenResult> {
    const args = ["--desktop", ...(options.resumeSessionId ? ["--resume", options.resumeSessionId] : [])];
    const command = ["claude", ...args];
    const result = await this.launch({ command: "claude", args, cwd: options.cwd });
    return {
      launched: result.launched,
      command,
      sessionId: options.resumeSessionId ?? null,
      seeded: false,
      detail: result.launched
        ? "launched `claude --desktop` — it does not accept an initial prompt, paste the instruction into the app once it opens"
        : `failed to launch claude: ${result.error ?? "unknown error"}`,
    };
  }
}
