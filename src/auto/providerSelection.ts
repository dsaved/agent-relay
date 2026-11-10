import { evaluateProviderAvailability } from "../handoff/usageDecision.js";
import type { SessionProvider } from "../sessions/types.js";
import type { UsageSnapshot } from "../usage/types.js";
import { isOnCooldown } from "./cooldown.js";
import type { ProviderCooldown, UnknownAvailabilityPolicy } from "./types.js";

export type SelectionDecision = "select" | "pause_exhausted" | "pause_unknown";

export interface SelectionResult {
  decision: SelectionDecision;
  provider: SessionProvider;
  reason: string;
  /** The fetched status, only when a usage check actually ran (not set when a cooldown short-circuited before one was needed) — lets the caller record a cooldown without re-fetching. */
  status?: UsageSnapshot;
}

export function otherProvider(provider: SessionProvider): SessionProvider {
  return provider === "codex" ? "claude" : "codex";
}

/**
 * Picks the one eligible alternative to `current` (there are only two
 * providers, so "select an eligible alternative" always means "the
 * other one", unless `pinned` forces a specific choice — used by tests
 * and by an operator who wants to rule out one direction). Reuses
 * `evaluateProviderAvailability` (Phase 1A/1B/2B) completely unchanged:
 * exhausted always pauses; available always proceeds; unknown only
 * proceeds if the caller's `unknownPolicy.allow` is explicitly true and
 * the per-provider attempt budget for "proceeding under unknown" isn't
 * already spent.
 */
export async function selectAlternativeProvider(
  current: SessionProvider,
  pinned: SessionProvider | null,
  getUsageStatus: (provider: SessionProvider) => Promise<UsageSnapshot>,
  cooldowns: Partial<Record<SessionProvider, ProviderCooldown>>,
  unknownPolicy: UnknownAvailabilityPolicy,
  unknownAttempts: Partial<Record<SessionProvider, number>>,
): Promise<SelectionResult> {
  const candidate = pinned ?? otherProvider(current);

  const cooldown = cooldowns[candidate];
  if (isOnCooldown(cooldown)) {
    return { decision: "pause_exhausted", provider: candidate, reason: `${candidate} is on cooldown: ${cooldown!.reason}` };
  }

  const status = await getUsageStatus(candidate);
  const decision = evaluateProviderAvailability(status);

  if (decision.decision === "block") {
    return { decision: "pause_exhausted", provider: candidate, reason: decision.reason, status };
  }
  if (decision.decision === "proceed_with_caution") {
    if (!unknownPolicy.allow) {
      return { decision: "pause_unknown", provider: candidate, reason: `${candidate} availability is unknown, and automatic execution under unknown availability is not enabled for this task`, status };
    }
    const attempts = unknownAttempts[candidate] ?? 0;
    if (attempts >= unknownPolicy.maxAttempts) {
      return { decision: "pause_unknown", provider: candidate, reason: `${candidate} has been tried ${attempts} time(s) under unknown availability, reaching the configured limit of ${unknownPolicy.maxAttempts}`, status };
    }
    return { decision: "select", provider: candidate, reason: `proceeding under unknown availability (explicitly enabled; attempt ${attempts + 1} of ${unknownPolicy.maxAttempts})`, status };
  }
  return { decision: "select", provider: candidate, reason: `${candidate} usage is available`, status };
}
