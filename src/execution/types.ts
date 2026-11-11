import type { SessionProvider } from "../sessions/types.js";

/**
 * Why a run ended, distinguished explicitly per the task's requirement:
 * rate limits, auth failures, context exhaustion, crashes, and
 * permission issues all need different handling upstream, so they're
 * never collapsed into one generic "error".
 */
export type ExecutionOutcomeKind =
  | "completed"
  | "rate_limited"
  | "auth_failed"
  | "context_exhausted"
  | "permission_required"
  | "crashed"
  | "timed_out"
  | "cancelled"
  | "invalid_output"
  | "unknown_error";

export interface ExecutionOutcome {
  kind: ExecutionOutcomeKind;
  /** Human-readable detail, when known — never fabricated when the signal is genuinely absent. */
  detail: string | null;
  /** Only set for "rate_limited": when the provider reports a reset time. */
  cooldownResetsAt: number | null;
}

export interface ExecutionEvent {
  /** epoch ms this process observed the event (not necessarily when the provider emitted it). */
  observedAt: number;
  raw: unknown;
}

export interface ExecutionResult {
  provider: SessionProvider;
  /** The session/thread id the destination provider reports, when any event revealed one. */
  sessionId: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Bounded — see maxOutputBytes in ExecutionRunOptions. */
  events: ExecutionEvent[];
  outcome: ExecutionOutcome;
  timedOut: boolean;
  /** true if output was discarded past maxOutputBytes — the run is not necessarily invalid, just incompletely observed. */
  outputTruncated: boolean;
}

export interface ExecutionRunOptions {
  cwd: string;
  /** The instruction to give a brand-new session. Ignored if `resumeSessionId` is set. */
  instruction: string;
  /** When set, resumes this existing destination-provider session instead of starting a new one, and sends `instruction` as the continuation message. */
  resumeSessionId?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /**
   * Phase 4's cooperative-cancellation path (requirement #5). When this
   * fires, the run stops exactly like a timeout — the whole process
   * group is signaled, never just the direct child — except the outcome
   * is reported as `"cancelled"`, not `"timed_out"`/`"crashed"`, so a
   * daemon-requested pause/stop is never mistaken for a failure.
   */
  signal?: AbortSignal;
}

/**
 * One coding-agent execution backend. Real implementations
 * (`CodexExecutionAdapter`, `ClaudeExecutionAdapter`) spawn the actual
 * CLI under subscription auth; tests inject a fake implementing this
 * same interface — never a real process — per the task's own
 * instruction not to run live coding-agent turns without separate
 * authorization.
 */
export interface AgentExecutionAdapter {
  readonly provider: SessionProvider;
  run(options: ExecutionRunOptions): Promise<ExecutionResult>;
}

export interface LiveOpenOptions {
  cwd: string;
  instruction: string;
  /** An existing destination-provider session to continue, when one is known. */
  resumeSessionId?: string | null;
}

export interface LiveOpenResult {
  launched: boolean;
  /** The actual command run — recorded for audit, never hidden. */
  command: string[];
  /** Only set when `resumeSessionId` was passed through — there's no way to learn an id from a detached GUI launch of a brand-new session. */
  sessionId: string | null;
  /** True only when the instruction was actually delivered into the destination (e.g. a successful `codex queue`). False means the app was opened/brought forward but the instruction still needs to be pasted in by hand — confirmed live for Claude: `--desktop` flatly refuses a prompt argument ("--desktop doesn't take a prompt yet. Run `claude --desktop`, then type it in the app."). */
  seeded: boolean;
  detail: string;
}

/**
 * Phase 8's live-app counterpart to `AgentExecutionAdapter`: opens a
 * visible, human-driven session in the destination's own app instead of
 * running one headlessly to a captured completion. Not every provider
 * has an equivalent primitive (see docs/LIVE_HANDOFF.md) — a provider
 * without one simply has no adapter implementing this interface.
 */
export interface LiveOpenAdapter {
  readonly provider: SessionProvider;
  open(options: LiveOpenOptions): Promise<LiveOpenResult>;
}
