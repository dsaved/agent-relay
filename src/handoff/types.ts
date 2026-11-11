import type { GitFileStatus, SessionProvider } from "../sessions/types.js";
import type { ExecutionOutcome } from "../execution/types.js";

export type HandoffStatus =
  | "pending" // prepared, not yet executed
  | "locked" // workspace lock acquired, about to run
  | "executing"
  | "completed"
  | "interrupted" // stopped partway (crash/timeout/signal) — resumable
  | "blocked" // refused before execution (exhausted provider, missing objective, lock conflict, inaccessible workspace)
  | "failed_validation" // destination provider completed but configured validation commands failed
  | "opened_live"; // Phase 8: a live, human-driven session was opened in the destination's own app — not captured to completion, see docs/LIVE_HANDOFF.md

export interface ValidationCommandResult {
  command: string;
  exitCode: number | null;
  passed: boolean;
}

/**
 * Evidence of the workspace-ownership checks run before this attempt —
 * recorded even when they caused the attempt to be blocked, so later
 * auditing never has to take "it was safe" on faith.
 */
export interface OwnershipVerification {
  /** null when the check was never reached (e.g. refused earlier for an unrelated reason), or when no activity check was configured at all. */
  activityStatus: "confirmed_busy" | "confirmed_idle" | "unknown" | null;
  activityReason: string | null;
  lockRecoveredFromCrash: boolean;
  lockOverrideUsed: boolean;
}

export interface ExecutionAttempt {
  attemptedAt: number;
  destinationProvider: SessionProvider;
  /** null until the destination adapter reports one (or on a resume, carried over from the prior attempt). */
  destinationSessionId: string | null;
  outcome: ExecutionOutcome | null;
  usageDecision: "started" | "blocked_exhausted" | "proceeded_with_caution";
  lockOverrideUsed: boolean;
  validationResults: ValidationCommandResult[] | null;
  ownershipVerification: OwnershipVerification;
}

/**
 * The structured, provider-independent handoff package. Every field the
 * task requires is here; none is a generated guess — `originalTaskObjective`,
 * `availableImplementationProgress`, `remainingImplementationSteps`, and
 * `knownErrors` are all `null`/empty unless something real (the source
 * provider's own metadata, or an explicit human-supplied value) populated
 * them. See docs/HANDOFF_ENGINE.md for the "never invent" policy this
 * type exists to enforce at the type level.
 */
export interface HandoffRecord {
  handoffId: string;
  taskId: string;

  sourceProvider: SessionProvider;
  /** Set once an execute() call commits to a direction; null while only prepared. */
  destinationProvider: SessionProvider | null;

  sourceSessionId: string;
  repoRoot: string | null;
  worktreePath: string | null;

  /** From the source provider's own recorded title, if it had one — never fabricated. Supplying one at `execute()` time fills this in when it was null. */
  originalTaskObjective: string | null;

  branch: string | null;
  commitSha: string | null;
  /** Modified/deleted/untracked files from `git status --porcelain=v1`, verbatim, at prepare time. */
  files: GitFileStatus[];

  /** Whatever structured progress the source provider itself reported (mirrors Phase 2A's HandoffSnapshot.availableProgressInformation) — null means none was available. */
  availableImplementationProgress: Record<string, unknown> | null;
  /** Populated only from real validation command runs recorded on this or a prior attempt; null until one has run. */
  validationResults: ValidationCommandResult[] | null;
  /** Free-text errors a human or a prior attempt explicitly recorded — never inferred from file state. */
  knownErrors: string[];
  /** Free-text steps a human explicitly supplied — never generated. */
  remainingImplementationSteps: string[];

  handoffReason: string | null;
  createdAt: number;

  status: HandoffStatus;
  attempts: ExecutionAttempt[];
}

export interface Task {
  taskId: string;
  createdAt: number;
  /** All handoffs ever created for this task, oldest first — a task can bounce between providers more than once. */
  handoffIds: string[];
}

export interface WorkspaceLockRecord {
  lockKey: string;
  workspacePath: string;
  holderPid: number;
  holderHandoffId: string;
  /** Random per-acquisition identifier, recorded for audit evidence (see docs/HANDOFF_ENGINE.md on the limits of PID-based liveness checks under PID reuse). */
  holderToken: string;
  acquiredAt: number;
}
