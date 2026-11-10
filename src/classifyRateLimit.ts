import type { CliTool, RateLimitStatus, RateLimitWindow } from "./adapters/types.js";

const CODEX_USAGE_LIMIT_RE = /usage limit|rate limit/i;

interface ClaudeRateLimitWindow {
  utilization: number;
  resetsAt: number;
}

interface ClaudeRateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: {
    status: "allowed" | "rejected" | string;
    unifiedWindows?: {
      five_hour?: ClaudeRateLimitWindow;
      seven_day?: ClaudeRateLimitWindow;
    };
  };
}

function toWindow(w: ClaudeRateLimitWindow | undefined): RateLimitWindow | undefined {
  if (!w) return undefined;
  return { usedPercent: Math.round(w.utilization * 100), resetsAt: w.resetsAt };
}

/**
 * Classifies one parsed line of `codex exec --json` output.
 * Codex's `--json` stream carries no structured rate-limit field (see
 * docs/FEASIBILITY.md); classification is necessarily a free-text match
 * on `turn.failed` / `error` message bodies.
 */
export function classifyCodexLine(line: unknown): RateLimitStatus | undefined {
  if (typeof line !== "object" || line === null || !("type" in line)) return undefined;
  const obj = line as { type: unknown; message?: unknown; error?: { message?: unknown } };
  if (obj.type !== "turn.failed" && obj.type !== "error") return undefined;

  const message = typeof obj.message === "string" ? obj.message : obj.error?.message;
  if (typeof message !== "string") return undefined;

  if (CODEX_USAGE_LIMIT_RE.test(message)) {
    return { tool: "codex", classification: "exhausted", rawMessage: message };
  }
  return { tool: "codex", classification: "unknown", rawMessage: message };
}

/**
 * Classifies one parsed line of `claude -p --output-format stream-json` output.
 * Claude emits a structured `rate_limit_event` with per-window utilization,
 * independent of whether the turn itself succeeded or failed.
 */
export function classifyClaudeLine(line: unknown): RateLimitStatus | undefined {
  if (typeof line !== "object" || line === null || !("type" in line)) return undefined;
  if ((line as { type: unknown }).type !== "rate_limit_event") return undefined;

  const event = line as ClaudeRateLimitEvent;
  const status = event.rate_limit_info?.status;
  const classification = status === "allowed" ? "ok" : status === "rejected" ? "exhausted" : "unknown";

  return {
    tool: "claude",
    classification,
    primary: toWindow(event.rate_limit_info?.unifiedWindows?.five_hour),
    secondary: toWindow(event.rate_limit_info?.unifiedWindows?.seven_day),
  };
}

/**
 * Scans a sequence of already-JSON-parsed event lines and returns the
 * most decisive classification found (an exhausted/ok verdict wins over
 * "unknown"; later events win ties, since they're more recent).
 */
export function classifyRateLimit(tool: CliTool, lines: unknown[]): RateLimitStatus {
  const classify = tool === "codex" ? classifyCodexLine : classifyClaudeLine;
  let best: RateLimitStatus = { tool, classification: "unknown" };

  for (const line of lines) {
    const result = classify(line);
    if (!result) continue;
    if (result.classification !== "unknown" || best.classification === "unknown") {
      best = result;
    }
  }
  return best;
}
