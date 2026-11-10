import { spawnRun } from "./spawnRun.js";
import { interpretCodexRun } from "./outcomeClassifier.js";
import type { AgentExecutionAdapter, ExecutionResult, ExecutionRunOptions } from "./types.js";

/**
 * Runs real `codex exec --json` turns under the installed CLI's own
 * ChatGPT subscription auth. `--sandbox workspace-write` is used
 * explicitly, never `--dangerously-bypass-approvals-and-sandbox` — this
 * adapter does not grant unrestricted execution.
 */
export class CodexExecutionAdapter implements AgentExecutionAdapter {
  readonly provider = "codex" as const;

  async run(options: ExecutionRunOptions): Promise<ExecutionResult> {
    const args = options.resumeSessionId
      ? ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "resume", options.resumeSessionId, options.instruction]
      : ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", options.instruction];

    const result = await spawnRun({
      command: "codex",
      args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
    const { sessionId, outcome } = interpretCodexRun(result);

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
