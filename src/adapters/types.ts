/**
 * Adapter interfaces only (Phase 0 scope). No implementations here —
 * see docs/FEASIBILITY.md for which of these are backed by a verified
 * CLI mechanism versus still UNVERIFIED/UNSUPPORTED.
 */

export type CliTool = "codex" | "claude";

export type AuthMethod = "subscription" | "api_key" | "unknown";

export interface AuthStatus {
  tool: CliTool;
  loggedIn: boolean;
  method: AuthMethod;
  /** e.g. codex: "ChatGPT"; claude: "claude.ai" (subscriptionType "pro"/"max") */
  detail?: string;
}

export interface SessionRef {
  tool: CliTool;
  sessionId: string;
  cwd: string;
  /** true if this session was most recently driven by a desktop app rather than a bare terminal */
  origin?: "desktop" | "cli" | "unknown";
}

export interface WorktreeHandle {
  tool: CliTool;
  repoRoot: string;
  worktreePath: string;
  branch?: string;
}

export interface RateLimitWindow {
  usedPercent: number;
  resetsAt: number | null;
  windowDurationMins?: number | null;
}

export type RateLimitClassification = "ok" | "exhausted" | "unknown";

export interface RateLimitStatus {
  tool: CliTool;
  classification: RateLimitClassification;
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  /** raw backend message, when classification came from a free-text error rather than a structured field */
  rawMessage?: string;
}

/**
 * Normalized shape for one line of a CLI's JSONL/stream event output.
 * Both tools emit richer, tool-specific payloads; this is the subset
 * agent-relay needs to drive classification and session bookkeeping.
 */
export interface CliEvent {
  tool: CliTool;
  kind: "lifecycle" | "message" | "rate_limit" | "error" | "result" | "unknown";
  raw: unknown;
}

/**
 * A CLI adapter's documented surface. Implementations are out of scope
 * for Phase 0 — this interface exists to pin down what Phase 1 would
 * need to implement against, per capability already classified in
 * docs/FEASIBILITY.md.
 */
export interface CliAdapter {
  readonly tool: CliTool;
  getVersion(): Promise<string>;
  getAuthStatus(): Promise<AuthStatus>;
  listSessions(): Promise<SessionRef[]>;
  createWorktree(repoRoot: string, name?: string): Promise<WorktreeHandle>;
  resumeSession(ref: SessionRef, prompt: string): AsyncIterable<CliEvent>;
  getRateLimitStatus(): Promise<RateLimitStatus>;
}
