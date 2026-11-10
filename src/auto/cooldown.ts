import type { ExecutionOutcome } from "../execution/types.js";
import type { UsageSnapshot } from "../usage/types.js";
import type { ProviderCooldown } from "./types.js";

export const DEFAULT_BASE_COOLDOWN_MS = 30_000;
export const DEFAULT_MAX_COOLDOWN_MS = 30 * 60_000;

/** Bounded exponential backoff — only used when no reset time is known; capped, never unbounded. */
function backoffCooldown(attemptNumber: number, reason: string, baseMs: number, maxMs: number): ProviderCooldown {
  const until = Date.now() + Math.min(maxMs, baseMs * 2 ** Math.max(0, attemptNumber));
  return { until, reason, fromReportedReset: false };
}

/** A provider's reported reset time always wins over a guess — "use recorded provider reset times when available" (requirement #5). */
export function cooldownFromUsageStatus(status: UsageSnapshot, attemptNumber: number, baseMs = DEFAULT_BASE_COOLDOWN_MS, maxMs = DEFAULT_MAX_COOLDOWN_MS): ProviderCooldown {
  if (status.primary?.resetsAt) {
    // `resetsAt` is epoch *seconds* (both providers' usage monitors agree on this convention), so it's converted to ms here, same as `cooldownFromOutcome` below.
    const untilMs = status.primary.resetsAt * 1000;
    return { until: untilMs, reason: `usage monitor reports reset at ${new Date(untilMs).toISOString()}`, fromReportedReset: true };
  }
  return backoffCooldown(attemptNumber, `no reset time reported; bounded backoff (attempt ${attemptNumber})`, baseMs, maxMs);
}

/** Same rule, for a cooldown derived from an execution outcome (e.g. a `rate_limited` run) rather than a pre-flight usage check. */
export function cooldownFromOutcome(outcome: ExecutionOutcome, attemptNumber: number, baseMs = DEFAULT_BASE_COOLDOWN_MS, maxMs = DEFAULT_MAX_COOLDOWN_MS): ProviderCooldown {
  if (outcome.cooldownResetsAt) {
    return { until: outcome.cooldownResetsAt * 1000, reason: `provider reported reset at ${new Date(outcome.cooldownResetsAt * 1000).toISOString()}`, fromReportedReset: true };
  }
  return backoffCooldown(attemptNumber, `${outcome.kind}: no reset time reported; bounded backoff (attempt ${attemptNumber})`, baseMs, maxMs);
}

export function isOnCooldown(cooldown: ProviderCooldown | undefined, now = Date.now()): boolean {
  return !!cooldown && cooldown.until > now;
}
