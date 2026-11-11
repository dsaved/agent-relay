import type { SessionProvider } from "../sessions/types.js";
import type { ExecutionOutcome } from "../execution/types.js";
import type { HandoffStatus } from "../handoff/types.js";

export type AutoState =
  | "queued"
  | "running"
  | "checkpointing"
  | "awaiting_ownership"
  | "selecting_provider"
  | "handing_off"
  | "validating"
  | "completed"
  | "paused_exhausted"
  | "paused_approval"
  | "failed"
  /** Phase 4: a user-requested stop that actually interrupted an in-flight execution — distinct from "failed", which stays reserved for an error/limit/refusal. A direct `stop()` call with nothing in flight still reports "failed", unchanged from Phase 3A, to avoid breaking existing callers. */
  | "stopped";

/**
 * Who can be trusted to be the only one writing to a workspace right
 * now. Automatic switching is permitted only from/into
 * `relay_managed` or `external_idle_confirmed` — never
 * `external_unknown`. Deliberately NOT derived from lock age, file
 * mtimes, or a provider being exhausted (none of those prove a desktop
 * agent has stopped) — only from `WorkspaceLockManager`'s own
 * PID-liveness result and Phase 2C's `classifyWorkspaceActivity`.
 */
export type OwnershipState = "relay_managed" | "external_idle_confirmed" | "external_unknown";

export interface ProviderCooldown {
  /** epoch ms this provider should not be retried before. */
  until: number;
  reason: string;
  /** true when `until` came from the provider's own reported reset time, rather than our own backoff guess. */
  fromReportedReset: boolean;
}

/** Bounded attempts under a provider's genuinely unknown availability — never an unconditional retry loop. */
export interface UnknownAvailabilityPolicy {
  /** Must be explicitly set true by the caller; defaults false (paused instead). */
  allow: boolean;
  maxAttempts: number;
  cooldownMs: number;
}

export interface AutoTransition {
  at: number;
  attemptId: string;
  from: AutoState;
  to: AutoState;
  provider: SessionProvider | null;
  reason: string | null;
}

export interface AutoTaskLimits {
  maxHandoffs: number;
  maxAttempts: number;
  maxRuntimeMs: number;
}

export interface AutoTaskState {
  taskId: string;
  state: AutoState;
  /** The provider currently (or most recently) executing this task's work. */
  currentProvider: SessionProvider | null;
  /** The HandoffRecord currently in play — set once a handoff leg has been created for the current provider transition. */
  currentHandoffId: string | null;
  attemptCount: number;
  handoffCount: number;
  startedAt: number;
  updatedAt: number;
  limits: AutoTaskLimits;
  unknownAvailabilityPolicy: UnknownAvailabilityPolicy;
  /** How many consecutive attempts have run under a merely "unknown" availability signal, per provider — reset once that provider reports a definitive answer. */
  unknownAttemptsByProvider: Partial<Record<SessionProvider, number>>;
  cooldowns: Partial<Record<SessionProvider, ProviderCooldown>>;
  validationCommands: string[];
  /** Explicit config override: when set, only this provider may ever be selected (used by tests and by a human pinning a direction) — selection logic otherwise picks the next eligible provider from `enabledProviders` automatically. */
  pinnedProvider: SessionProvider | null;
  /** Every provider this task may ever hand off to, in priority order — defaults to `["codex", "claude"]` for byte-for-byte-identical behavior with every task created before a third provider existed. A provider has to be listed here to ever be selected, pinned or not. */
  enabledProviders: SessionProvider[];
  /** Set by `selecting_provider`, consumed by `handing_off` in the same leg — which provider was just chosen. */
  pendingDestination: SessionProvider | null;
  failureReason: string | null;
  lastOutcome: ExecutionOutcome | null;
  /** The last leg's overall `HandoffRecord.status` (e.g. "completed"/"failed_validation"/"interrupted") — `lastOutcome` alone can't distinguish "failed_validation" from "completed", since both have outcome.kind === "completed". */
  lastHandoffStatus: HandoffStatus | null;
  transitions: AutoTransition[];
}
