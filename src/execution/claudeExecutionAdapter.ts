import { spawnRun } from "./spawnRun.js";
import { interpretClaudeRun } from "./outcomeClassifier.js";
import type { AgentExecutionAdapter, ExecutionResult, ExecutionRunOptions } from "./types.js";

/**
 * Runs real `claude -p --output-format stream-json` turns under the
 * installed CLI's own Claude subscription auth. `--permission-mode
 * acceptEdits` is used explicitly, never `--dangerously-skip-permissions`
 * / `bypassPermissions` — this adapter does not grant unrestricted
 * execution, only automatic approval of file edits (the minimum needed
 * to make a non-interactive coding turn useful at all, same choice
 * verified live in Phase 2A §4).
 */
export class ClaudeExecutionAdapter implements AgentExecutionAdapter {
  readonly provider = "claude" as const;

  async run(options: ExecutionRunOptions): Promise<ExecutionResult> {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      ...(options.resumeSessionId ? ["--resume", options.resumeSessionId] : []),
      options.instruction,
    ];

    const result = await spawnRun({
      command: "claude",
      args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
    const { sessionId, outcome } = interpretClaudeRun(result);

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
