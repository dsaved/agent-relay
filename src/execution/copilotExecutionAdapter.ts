import { spawnRun } from "./spawnRun.js";
import { interpretCopilotRun } from "./outcomeClassifier.js";
import type { AgentExecutionAdapter, ExecutionResult, ExecutionRunOptions } from "./types.js";

/**
 * Runs real `copilot -p` turns under the installed CLI's own Copilot
 * subscription auth (`copilot login` — OAuth device/browser flow, same
 * category as `claude`/`codex`). Grounded in this machine's actual
 * `copilot --help` output (docs/MULTI_AGENT.md), not guesswork:
 * `--output-format json` for structured JSONL, `--allow-tool write` as
 * the narrowest grant that lets a non-interactive run actually edit
 * files — Copilot's non-interactive mode denies every tool request it
 * isn't explicitly allowed (there's no human to prompt), so *some* grant
 * is required, and this project's own rule is to never grant
 * unrestricted execution (`--allow-all`/`--yolo`), same discipline as
 * Claude's `acceptEdits`/Codex's `workspace-write`.
 */
export class CopilotExecutionAdapter implements AgentExecutionAdapter {
  readonly provider = "copilot" as const;

  async run(options: ExecutionRunOptions): Promise<ExecutionResult> {
    const args = ["-p", options.instruction, "--output-format", "json", "--allow-tool", "write", ...(options.resumeSessionId ? ["--resume", options.resumeSessionId] : [])];

    const result = await spawnRun({
      command: "copilot",
      args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      signal: options.signal,
    });
    const { sessionId, outcome } = interpretCopilotRun(result);

    return {
      provider: this.provider,
      sessionId: sessionId ?? options.resumeSessionId ?? null,
      exitCode: result.exitCode,
      signal: result.signal,
      events: result.events,
      outcome,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated,
    };
  }
}
