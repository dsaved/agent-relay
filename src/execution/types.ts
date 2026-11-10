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
