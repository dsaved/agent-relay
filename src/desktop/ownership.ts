import type { ProviderActivitySignal } from "../handoff/lock.js";
import type { DesktopOwnershipState } from "./types.js";

export interface DesktopOwnershipInput {
  /** The record's last stored ownership state, or null if this session has never been registered/assessed before. */
  priorState: DesktopOwnershipState | null;
  /** `WorkspaceLockManager.isHeldByThisProcess(workspacePath)` — the one unambiguous "we manage it" signal. */
  heldByThisProcess: boolean;
  /** Phase 2C's tri-state signal (`classifyWorkspaceActivity`), freshly computed — never cached across calls. */
  activitySignal: ProviderActivitySignal;
  /** True only on the exact call that is itself the user's explicit `agent-relay desktop handoff ... --to` authorization — never inferred or carried forward from a past call. */
  handoffAuthorizedNow: boolean;
  /** Spec condition #3: the source is a Relay-managed worker whose entire process group has already terminated (not merely "the lock looks stale"). */
  sourceProcessGroupTerminated: boolean;
}

export interface DesktopOwnershipAssessment {
  state: DesktopOwnershipState;
  reason: string;
  /** True only when this exact call establishes enough evidence to acquire the workspace lock right now. Never a standing grant — the next call re-derives this from scratch. */
  canTakeOwnership: boolean;
}

/**
 * Pure function implementing Phase 3B's 7-state ownership lifecycle
 * (requirement #2). Every output is re-derived from this call's real
 * signals — a past `handoff_requested` authorization or a past
 * `relay_owned`/`released` record is never, by itself, treated as
 * standing permission for a later call (spec: "do not treat a user
 * confirmation as permanent permission to override later conflicting
 * activity"). `--force-lock` is not a parameter here on purpose: this
 * function only ever reports what the real evidence supports: the
 * forcing decision itself stays an explicit, separate CLI-level choice,
 * exactly like Phase 2C/3A's existing rule.
 */
export function assessDesktopOwnership(input: DesktopOwnershipInput): DesktopOwnershipAssessment {
  const { priorState, heldByThisProcess, activitySignal, handoffAuthorizedNow, sourceProcessGroupTerminated } = input;

  if (heldByThisProcess) {
    return { state: "relay_owned", reason: "this process holds the workspace lock", canTakeOwnership: true };
  }

  if (priorState === "relay_owned" && activitySignal.status === "confirmed_busy") {
    // We no longer hold the lock, and nobody routed this through the clean
    // "released" path (that's set directly by the handoff glue, not here)
    // — the only way to reach this branch is new external activity showing
    // up while we thought we owned it.
    return { state: "relinquished", reason: `lock was lost and external activity is now confirmed: ${activitySignal.reason}`, canTakeOwnership: false };
  }

  if (handoffAuthorizedNow) {
    const sourceConfirmedStopped = activitySignal.status === "confirmed_idle" || sourceProcessGroupTerminated;
    return {
      state: "handoff_requested",
      reason: sourceProcessGroupTerminated
        ? "source was a Relay-managed worker whose process group has terminated"
        : `activity check (${activitySignal.status}): ${activitySignal.reason}`,
      canTakeOwnership: sourceConfirmedStopped,
    };
  }

  if (priorState === "handoff_requested") {
    // A prior authorization exists, but THIS call isn't a fresh one — never
    // reuse it as standing permission; only report whether current evidence
    // alone would now support taking ownership if the caller re-authorizes.
    const sourceConfirmedStopped = activitySignal.status === "confirmed_idle" || sourceProcessGroupTerminated;
    return {
      state: "handoff_requested",
      reason: sourceConfirmedStopped
        ? "previously authorized; source now confirmed stopped — re-run `desktop handoff` to transfer"
        : `previously authorized; still pending (${activitySignal.status}): ${activitySignal.reason}`,
      canTakeOwnership: false,
    };
  }

  switch (activitySignal.status) {
    case "confirmed_busy":
      return { state: "external_active", reason: activitySignal.reason, canTakeOwnership: false };
    case "unknown":
      return { state: "external_unknown", reason: activitySignal.reason, canTakeOwnership: false };
    case "confirmed_idle":
      return { state: "external_unmanaged", reason: activitySignal.reason, canTakeOwnership: false };
  }
}
