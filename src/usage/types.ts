/**
 * Common shape both CodexUsageMonitor (Phase 1A) and ClaudeUsageMonitor
 * (Phase 1B) report through, so a caller — or `agent-relay usage all` —
 * can treat them interchangeably. Each tool's own status type (e.g.
 * CodexUsageStatus) is a structural superset of UsageSnapshot: it adds
 * tool-specific fields but satisfies this interface as-is.
 */
export type UsageClassification = "available" | "exhausted" | "unknown";

export interface UsageWindow {
  usedPercent: number;
  resetsAt: number | null;
  windowDurationMins?: number | null;
}

export interface UsageSnapshot {
  classification: UsageClassification;
  /** epoch ms when this reading was taken (Codex: the RPC call; Claude: the observed event). null if no reading exists at all. */
  observedAt: number | null;
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  /** set when classification is "unknown" because of a handled failure (missing CLI, stale/missing data, protocol error), not a genuinely ambiguous backend answer */
  error?: string;
}

export interface UsageMonitor {
  getStatus(): Promise<UsageSnapshot>;
  close(): Promise<void>;
}
