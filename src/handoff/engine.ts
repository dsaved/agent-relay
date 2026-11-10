import { CodexUsageMonitor } from "../codex/usageMonitor.js";
import { ClaudeUsageMonitor } from "../claude/usageMonitor.js";
import { discoverAllSessions } from "../sessions/discoverAll.js";
import type { SessionAssociation, SessionProvider } from "../sessions/types.js";
import type { UsageSnapshot } from "../usage/types.js";
import { CodexExecutionAdapter } from "../execution/codexExecutionAdapter.js";
import { ClaudeExecutionAdapter } from "../execution/claudeExecutionAdapter.js";
import type { AgentExecutionAdapter, ExecutionResult } from "../execution/types.js";
import { HandoffStore } from "./store.js";
import { WorkspaceLockManager, type ProviderActivitySignal } from "./lock.js";
import { evaluateProviderAvailability } from "./usageDecision.js";
import { buildContinuationInstruction, buildResumeNudge } from "./instruction.js";
import { runValidationCommands } from "./validation.js";
import type { ExecutionAttempt, HandoffRecord, OwnershipVerification } from "./types.js";

export interface ExecuteHandoffOptions {
  to: SessionProvider;
  suppliedObjective?: string;
  /** Wired to the CLI's `--force-lock`. Per docs/HANDOFF_ENGINE.md, this is the *only* way past a live/busy/unknown activity signal — it exists for an explicit, user-initiated override, never for automatic retry logic. */
  forceLockOverride?: boolean;
  validationCommands?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Phase 4's cooperative-cancellation path — threaded straight to the destination adapter's `run()`. Nobody passed one before Phase 4; omitting it is identical to today's behavior. */
  signal?: AbortSignal;
}

export interface ExecuteHandoffResult {
  handoff: HandoffRecord;
  attempt: ExecutionAttempt;
  /** Set only when execution never started — exhausted destination, lock conflict, unconfirmed activity, or an inaccessible workspace. */
  blockedReason?: string;
  /** The destination adapter's raw result, only when `adapter.run()` was actually called this attempt (never set on a blocked attempt). Not persisted in `HandoffRecord` — this is for in-process callers like Phase 3A's `AutomaticHandoffCoordinator`, which needs the raw events to passively feed `ClaudeUsageMonitor` without any extra model call. */
  lastExecutionResult?: ExecutionResult;
}

export interface HandoffEngineDeps {
  store?: HandoffStore;
  lockManager?: WorkspaceLockManager;
  adapters?: Partial<Record<SessionProvider, AgentExecutionAdapter>>;
  /** Defaults to the real Codex/Claude usage monitors from Phase 1A/1B. Claude's will almost always report "unknown" absent any fed observation — that's the honest answer, not a bug (see docs/FEASIBILITY.md Phase 1B). */
  getUsageStatus?: (provider: SessionProvider) => Promise<UsageSnapshot>;
  /**
   * Defaults to re-running Phase 2A discovery against the workspace
   * path — deliberately including the handoff's own source session
   * (Phase 2C hardening: a still-active source is exactly the thing
   * this check must catch, not filter out). Must always resolve to one
   * of the three `ActivityStatus` values; "unknown" is treated as
   * unsafe for automatic takeover (see `WorkspaceLockManager.acquire`).
   */
  checkProviderActivity?: (workspacePath: string) => Promise<ProviderActivitySignal>;
}

const RESUMABLE_STATUSES = new Set(["interrupted", "executing"]);

const NO_OWNERSHIP_CHECK: OwnershipVerification = { activityStatus: null, activityReason: null, lockRecoveredFromCrash: false, lockOverrideUsed: false };

async function defaultGetUsageStatus(provider: SessionProvider): Promise<UsageSnapshot> {
  if (provider === "codex") {
    const monitor = new CodexUsageMonitor();
    try {
      return await monitor.getStatus();
    } finally {
      await monitor.close();
    }
  }
  const monitor = new ClaudeUsageMonitor();
  try {
    return await monitor.getStatus();
  } finally {
    await monitor.close();
  }
}

/**
 * Per-provider activity policy (Phase 2C hardening):
 *
 * - Claude: `claude agents --json` only lists processes that are
 *   actually running (Phase 2A §1), so its signal is trustworthy either
 *   way — "busy" means busy, and finding no process at all for this
 *   workspace is a genuine, positive "confirmed idle".
 * - Codex: `thread/list`'s `status` field cannot confirm liveness from
 *   this process (Phase 2A/docs/SESSION_DISCOVERY.md §1) — only its
 *   `"active"` value is a real signal, and it's a busy one. Anything
 *   else (including the common case of a perfectly ordinary, long-since-
 *   finished thread that still exists in history) is reported
 *   `"unknown"`, never `"confirmed_idle"` — so a Codex-sourced or
 *   Codex-destined handoff requires an explicit `forceOverride` by
 *   design, every time, unless no Codex session shows up for that
 *   workspace at all.
 */
/**
 * Pure classification, split out from `defaultCheckProviderActivity` so
 * the provider-specific policy itself is unit-testable without any real
 * discovery call (see test/activityClassification.test.ts).
 */
export function classifyWorkspaceActivity(sessionsAtPath: SessionAssociation[]): ProviderActivitySignal {
  const busyClaude = sessionsAtPath.find((s) => s.provider === "claude" && s.status === "busy");
  if (busyClaude) return { status: "confirmed_busy", reason: `Claude session ${busyClaude.sessionId} reports status "busy" for this workspace` };

  const activeCodex = sessionsAtPath.find((s) => s.provider === "codex" && s.status === "active");
  if (activeCodex) return { status: "confirmed_busy", reason: `Codex thread ${activeCodex.sessionId} reports status "active" for this workspace` };

  const codexPresent = sessionsAtPath.some((s) => s.provider === "codex");
  if (codexPresent) {
    return { status: "unknown", reason: "Codex session(s) exist for this workspace; thread/list cannot confirm liveness from this process" };
  }

  const claudePresent = sessionsAtPath.some((s) => s.provider === "claude");
  return { status: "confirmed_idle", reason: claudePresent ? "all discovered Claude sessions for this workspace report idle" : "no running session found for this workspace" };
}

export async function defaultCheckProviderActivity(workspacePath: string): Promise<ProviderActivitySignal> {
  const { sessions } = await discoverAllSessions();
  const atPath = sessions.filter((s) => s.projectDir === workspacePath || s.repoRoot === workspacePath || s.worktreePath === workspacePath);
  return classifyWorkspaceActivity(atPath);
}

/**
 * Orchestrates one handoff attempt end to end (requirement #5's ten
 * steps). Every dependency is injectable so tests can run this against
 * fake agents and a disposable store/lock root, never a real process —
 * per the task's own instruction not to run live coding-agent turns
 * without separate authorization.
 */
export class HandoffEngine {
  private readonly store: HandoffStore;
  private readonly lockManager: WorkspaceLockManager;
  private readonly adapters: Record<SessionProvider, AgentExecutionAdapter>;
  private readonly getUsageStatus: (provider: SessionProvider) => Promise<UsageSnapshot>;
  private readonly checkProviderActivity: (workspacePath: string) => Promise<ProviderActivitySignal>;

  constructor(deps: HandoffEngineDeps = {}) {
    this.store = deps.store ?? new HandoffStore();
    this.lockManager = deps.lockManager ?? new WorkspaceLockManager(this.store);
    this.adapters = { codex: deps.adapters?.codex ?? new CodexExecutionAdapter(), claude: deps.adapters?.claude ?? new ClaudeExecutionAdapter() };
    this.getUsageStatus = deps.getUsageStatus ?? defaultGetUsageStatus;
    this.checkProviderActivity = deps.checkProviderActivity ?? defaultCheckProviderActivity;
  }

  async executeHandoff(handoffId: string, options: ExecuteHandoffOptions): Promise<ExecuteHandoffResult> {
    const handoff = await this.store.loadHandoff(handoffId);
    if (!handoff) throw new Error(`no handoff found with id "${handoffId}"`);
    if (handoff.destinationProvider && handoff.destinationProvider !== options.to) {
      throw new Error(`handoff "${handoffId}" already targets "${handoff.destinationProvider}"; cannot redirect to "${options.to}"`);
    }
    if (options.to === handoff.sourceProvider) {
      throw new Error(`cross-provider handoff requires a destination different from the source ("${handoff.sourceProvider}")`);
    }

    const objective = handoff.originalTaskObjective ?? options.suppliedObjective ?? null;
    if (!objective) {
      throw new Error(`handoff "${handoffId}" has no recorded task objective — supply one via suppliedObjective before executing`);
    }
    if (!handoff.originalTaskObjective) handoff.originalTaskObjective = options.suppliedObjective ?? null;
    handoff.destinationProvider = options.to;

    const workspacePath = handoff.worktreePath ?? handoff.repoRoot;

    const usageStatus = await this.getUsageStatus(options.to);
    const usageDecision = evaluateProviderAvailability(usageStatus);
    const baseAttempt = (ownershipVerification: OwnershipVerification): Omit<ExecutionAttempt, "outcome" | "destinationSessionId" | "validationResults"> => ({
      attemptedAt: Date.now(),
      destinationProvider: options.to,
      usageDecision: usageDecision.decision === "block" ? "blocked_exhausted" : usageDecision.decision === "start" ? "started" : "proceeded_with_caution",
      lockOverrideUsed: ownershipVerification.lockOverrideUsed,
      ownershipVerification,
    });

    const blocked = async (ownershipVerification: OwnershipVerification, reason: string): Promise<ExecuteHandoffResult> => {
      const attempt: ExecutionAttempt = { ...baseAttempt(ownershipVerification), destinationSessionId: null, outcome: null, validationResults: null };
      handoff.status = "blocked";
      handoff.attempts.push(attempt);
      await this.store.saveHandoff(handoff);
      return { handoff, attempt, blockedReason: reason };
    };

    if (usageDecision.decision === "block") {
      return blocked(NO_OWNERSHIP_CHECK, usageDecision.reason);
    }
    if (!workspacePath) {
      return blocked(NO_OWNERSHIP_CHECK, "handoff has no recorded repository or worktree path");
    }

    const lockResult = await this.lockManager.acquire(workspacePath, handoff.handoffId, {
      forceOverride: options.forceLockOverride,
      checkProviderActivity: () => this.checkProviderActivity(workspacePath),
    });
    if (!lockResult.acquired) {
      const ownershipVerification: OwnershipVerification = {
        activityStatus: lockResult.activitySignal?.status ?? null,
        activityReason: lockResult.activitySignal?.reason ?? null,
        lockRecoveredFromCrash: false,
        lockOverrideUsed: false,
      };
      return blocked(ownershipVerification, lockResult.reason);
    }

    const ownershipVerification: OwnershipVerification = {
      activityStatus: lockResult.activitySignal?.status ?? null,
      activityReason: lockResult.activitySignal?.reason ?? null,
      lockRecoveredFromCrash: lockResult.recoveredFromCrash,
      lockOverrideUsed: lockResult.overrideUsed,
    };

    const previousStatus = handoff.status;
    handoff.status = "executing";
    await this.store.saveHandoff(handoff);

    try {
      const priorAttempt = handoff.attempts[handoff.attempts.length - 1];
      const canResume = RESUMABLE_STATUSES.has(previousStatus) && priorAttempt?.destinationProvider === options.to && !!priorAttempt?.destinationSessionId;
      const resumeSessionId = canResume ? (priorAttempt?.destinationSessionId ?? undefined) : undefined;
      const instruction = resumeSessionId ? buildResumeNudge() : buildContinuationInstruction(handoff, objective);

      const adapter = this.adapters[options.to];
      const result = await adapter.run({ cwd: workspacePath, instruction, resumeSessionId, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, signal: options.signal });

      const destinationSessionId = result.sessionId ?? resumeSessionId ?? null;
      let validationResults = null;
      if (result.outcome.kind === "completed" && options.validationCommands && options.validationCommands.length > 0) {
        validationResults = await runValidationCommands(workspacePath, options.validationCommands);
      }
      const validationPassed = !validationResults || validationResults.every((v) => v.passed);

      handoff.status = result.outcome.kind === "completed" ? (validationPassed ? "completed" : "failed_validation") : "interrupted";

      const attempt: ExecutionAttempt = { ...baseAttempt(ownershipVerification), destinationSessionId, outcome: result.outcome, validationResults };
      if (validationResults) handoff.validationResults = validationResults;
      handoff.attempts.push(attempt);
      await this.store.saveHandoff(handoff);
      return { handoff, attempt, lastExecutionResult: result };
    } finally {
      // The adapter's run() has already resolved by this point — its own
      // process-group termination (see src/execution/spawnRun.ts) means
      // the destination process and its descendants are confirmed stopped
      // before we ever reach this release.
      await this.lockManager.release(workspacePath, handoff.handoffId);
    }
  }
}
