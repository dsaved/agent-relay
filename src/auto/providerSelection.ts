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

/** Every provider this codebase knows how to build an adapter for. New ones are added here and nowhere else needs to know the full set exists — see docs/MULTI_AGENT.md's checklist. */
export const ALL_PROVIDERS: SessionProvider[] = ["codex", "claude", "copilot"];

/** @deprecated kept only for the two-provider case; prefer `candidateProviders` for anything that needs to work with more than two. */
export function otherProvider(provider: SessionProvider): SessionProvider {
  return provider === "codex" ? "claude" : "codex";
}

/**
 * Every *other* enabled provider, in `enabled`'s own order — a pinned
 * override collapses this to that one provider (or none, if it happens
 * to equal `current`). With exactly two enabled providers this is
 * always a single-element list, identical to `otherProvider`'s old
 * behavior; with more, it's the real candidate list
 * `selectAlternativeProvider` now tries in order.
 */
export function candidateProviders(current: SessionProvider, enabled: SessionProvider[], pinned: SessionProvider | null): SessionProvider[] {
  if (pinned) return pinned === current ? [] : [pinned];
  return enabled.filter((p) => p !== current);
}

/**
 * Picks the first eligible alternative to `current` among every other
 * *enabled* provider, in order (`enabled` defaults to today's
 * `["codex", "claude"]`, so a caller that never opts into a third
 * provider sees byte-for-byte the same single-candidate behavior as
 * before — this is a generalization, not a behavior change, for the
 * two-provider case; confirmed by the existing coordinator test suite
 * passing unmodified). `pinned` forces a specific choice, same as
 * always. Reuses `evaluateProviderAvailability` (Phase 1A/1B/2B)
 * completely unchanged per candidate: exhausted or on-cooldown skips to
 * the next candidate instead of pausing immediately — the whole point
 * of having more than one alternative; `unknown` is skipped the same
 * way unless the caller's `unknownPolicy.allow` is explicitly true and
 * that candidate's own attempt budget isn't already spent. If every
 * candidate is blocked, the *last* one checked's reason is reported —
 * simplest honest choice, not an attempt to rank reasons.
 */
export async function selectAlternativeProvider(
  current: SessionProvider,
  pinned: SessionProvider | null,
  getUsageStatus: (provider: SessionProvider) => Promise<UsageSnapshot>,
  cooldowns: Partial<Record<SessionProvider, ProviderCooldown>>,
  unknownPolicy: UnknownAvailabilityPolicy,
  unknownAttempts: Partial<Record<SessionProvider, number>>,
  enabled: SessionProvider[] = ["codex", "claude"],
): Promise<SelectionResult> {
  const candidates = candidateProviders(current, enabled, pinned);
  if (candidates.length === 0) {
    return {
      decision: "pause_unknown",
      provider: current,
      reason: pinned ? `pinned provider "${pinned}" is not a valid alternative to the current provider "${current}"` : "no other enabled provider is configured as an alternative",
    };
  }

  let lastBlocked: SelectionResult | null = null;
  for (const candidate of candidates) {
    const cooldown = cooldowns[candidate];
    if (isOnCooldown(cooldown)) {
      lastBlocked = { decision: "pause_exhausted", provider: candidate, reason: `${candidate} is on cooldown: ${cooldown!.reason}` };
      continue;
    }

    const status = await getUsageStatus(candidate);
    const decision = evaluateProviderAvailability(status);

    if (decision.decision === "block") {
      lastBlocked = { decision: "pause_exhausted", provider: candidate, reason: decision.reason, status };
      continue;
    }
    if (decision.decision === "proceed_with_caution") {
      if (!unknownPolicy.allow) {
        lastBlocked = { decision: "pause_unknown", provider: candidate, reason: `${candidate} availability is unknown, and automatic execution under unknown availability is not enabled for this task`, status };
        continue;
      }
      const attempts = unknownAttempts[candidate] ?? 0;
      if (attempts >= unknownPolicy.maxAttempts) {
        lastBlocked = { decision: "pause_unknown", provider: candidate, reason: `${candidate} has been tried ${attempts} time(s) under unknown availability, reaching the configured limit of ${unknownPolicy.maxAttempts}`, status };
        continue;
      }
      return { decision: "select", provider: candidate, reason: `proceeding under unknown availability (explicitly enabled; attempt ${attempts + 1} of ${unknownPolicy.maxAttempts})`, status };
    }
    return { decision: "select", provider: candidate, reason: `${candidate} usage is available`, status };
  }

  return lastBlocked!;
}
