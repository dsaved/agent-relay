import type { ProviderActivitySignal } from "../handoff/lock.js";
import type { WorkspaceLockManager } from "../handoff/lock.js";
import type { OwnershipState } from "./types.js";

export interface OwnershipAssessment {
  state: OwnershipState;
  signal: ProviderActivitySignal | null;
}

/**
 * The three-state ownership model (requirement #2), computed from
 * exactly two real signals this codebase already trusts — never from
 * lock age, file mtimes, or a provider being exhausted (none of those
 * prove a desktop agent has stopped):
 *
 * 1. `isHeldByThisProcess` — is *this very process* the recorded lock
 *    holder for this workspace right now? If so, we unambiguously
 *    manage it ourselves.
 * 2. Otherwise, Phase 2C's `checkProviderActivity` (the same function
 *    `HandoffEngine` uses internally) — `confirmed_idle` only comes
 *    back when it's a genuine positive signal (Claude: no running
 *    process found; Codex: no Codex session at all for this path).
 *    `confirmed_busy` or `unknown` both mean "an independently
 *    controlled session may still be active" — `external_unknown`.
 */
export async function assessOwnership(
  workspacePath: string,
  lockManager: WorkspaceLockManager,
  checkProviderActivity: () => Promise<ProviderActivitySignal>,
): Promise<OwnershipAssessment> {
  if (await lockManager.isHeldByThisProcess(workspacePath)) {
    return { state: "relay_managed", signal: null };
  }
  const signal = await checkProviderActivity();
  if (signal.status === "confirmed_idle") return { state: "external_idle_confirmed", signal };
  return { state: "external_unknown", signal };
}
