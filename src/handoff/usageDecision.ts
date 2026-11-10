import type { UsageSnapshot } from "../usage/types.js";

export type UsageDecisionKind = "start" | "block" | "proceed_with_caution";

export interface UsageDecision {
  decision: UsageDecisionKind;
  reason: string;
}

/**
 * The decision logic requirement #6 asks for, kept separate from
 * whatever calls it: an exhausted provider is always blocked; an
 * available one always starts; and "unknown" never becomes "available"
 * by assumption — it's its own distinct decision, `proceed_with_caution`,
 * so an explicit human-invoked `handoff execute` can still go ahead
 * (consistent with "do not implement automatic switching yet" — only a
 * later, automatic caller needs to decide whether to treat caution as a
 * block, and this function hands it that choice without baking it in).
 */
export function evaluateProviderAvailability(status: UsageSnapshot): UsageDecision {
  if (status.classification === "exhausted") {
    const reset = status.primary?.resetsAt ? ` (resets ${new Date(status.primary.resetsAt * 1000).toISOString()})` : "";
    return { decision: "block", reason: `provider usage is exhausted${reset}` };
  }
  if (status.classification === "available") {
    return { decision: "start", reason: "provider usage is available" };
  }
  return { decision: "proceed_with_caution", reason: status.error ?? "provider usage status is unknown" };
}
