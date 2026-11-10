import { randomUUID } from "node:crypto";
import { CodexUsageMonitor } from "../codex/usageMonitor.js";
import { ClaudeUsageMonitor } from "../claude/usageMonitor.js";
import { HandoffEngine, defaultCheckProviderActivity } from "../handoff/engine.js";
import { HandoffStore } from "../handoff/store.js";
import { WorkspaceLockManager, type ProviderActivitySignal } from "../handoff/lock.js";
import type { SessionProvider } from "../sessions/types.js";
import type { AgentExecutionAdapter } from "../execution/types.js";
import type { UsageSnapshot } from "../usage/types.js";
import { assessOwnership } from "./ownership.js";
import { cooldownFromOutcome, cooldownFromUsageStatus, isOnCooldown } from "./cooldown.js";
import { otherProvider, selectAlternativeProvider } from "./providerSelection.js";
import { getOrCreateNextLegHandoff } from "./followOnHandoff.js";
import type { AutoState, AutoTaskState, AutoTransition } from "./types.js";

const TERMINAL_STATES = new Set<AutoState>(["completed", "failed", "stopped"]);
const PAUSED_STATES = new Set<AutoState>(["paused_exhausted", "paused_approval"]);

export interface StartAutoTaskOptions {
  suppliedObjective?: string;
  validationCommands?: string[];
  allowUnknownAvailability?: boolean;
  maxUnknownAttempts?: number;
  unknownCooldownMs?: number;
  maxHandoffs?: number;
  maxAttempts?: number;
  maxRuntimeMs?: number;
  pinnedProvider?: SessionProvider | null;
  /** Phase 4's cooperative-cancellation path — a daemon-held `AbortController.signal`, checked right before and threaded into the destination adapter's `run()`. Omitting it (every Phase 0-3B caller) is identical to today's behavior. */
  signal?: AbortSignal;
}

export interface AutomaticHandoffCoordinatorDeps {
  store?: HandoffStore;
  lockManager?: WorkspaceLockManager;
  adapters?: Partial<Record<SessionProvider, AgentExecutionAdapter>>;
  getUsageStatus?: (provider: SessionProvider) => Promise<UsageSnapshot>;
  checkProviderActivity?: (workspacePath: string) => Promise<ProviderActivitySignal>;
  /** Fed passively from every real Claude execution's own output — never from a prompt sent solely to check availability (requirement #3). Defaults to one instance kept alive for this coordinator's whole lifetime, so later decisions benefit from earlier observations. */
  claudeUsageMonitor?: ClaudeUsageMonitor;
}

/**
 * Supervises one task across provider boundaries: detects that the
 * provider currently expected to do the work is unavailable or has
 * failed, picks the other one (reusing `HandoffEngine`, unchanged, for
 * the actual transfer), and repeats until the work completes, a limit
 * is hit, or something requires a human.
 *
 * Every dependency is injectable; tests always supply fake execution
 * adapters and usage/activity functions — this coordinator never runs a
 * live coding-agent turn on its own initiative, and Phase 3A ships with
 * no live run performed, per the task's own instruction.
 */
export class AutomaticHandoffCoordinator {
  private readonly store: HandoffStore;
  private readonly lockManager: WorkspaceLockManager;
  private readonly engine: HandoffEngine;
  private readonly getUsageStatus: (provider: SessionProvider) => Promise<UsageSnapshot>;
  private readonly checkProviderActivity: (workspacePath: string) => Promise<ProviderActivitySignal>;
  private readonly claudeUsageMonitor: ClaudeUsageMonitor;

  constructor(deps: AutomaticHandoffCoordinatorDeps = {}) {
    this.store = deps.store ?? new HandoffStore();
    this.lockManager = deps.lockManager ?? new WorkspaceLockManager(this.store);
    this.claudeUsageMonitor = deps.claudeUsageMonitor ?? new ClaudeUsageMonitor();
    this.checkProviderActivity = deps.checkProviderActivity ?? defaultCheckProviderActivity;
    this.getUsageStatus = deps.getUsageStatus ?? ((provider) => this.defaultGetUsageStatus(provider));
    this.engine = new HandoffEngine({
      store: this.store,
      lockManager: this.lockManager,
      adapters: deps.adapters,
      getUsageStatus: this.getUsageStatus,
      checkProviderActivity: this.checkProviderActivity,
    });
  }

  private async defaultGetUsageStatus(provider: SessionProvider): Promise<UsageSnapshot> {
    if (provider === "claude") return this.claudeUsageMonitor.getStatus();
    const monitor = new CodexUsageMonitor();
    try {
      return await monitor.getStatus();
    } finally {
      await monitor.close();
    }
  }

  private transition(state: AutoTaskState, to: AutoState, provider: SessionProvider | null, reason: string | null): AutoTaskState {
    const entry: AutoTransition = { at: Date.now(), attemptId: randomUUID(), from: state.state, to, provider, reason };
    return { ...state, state: to, updatedAt: entry.at, transitions: [...state.transitions, entry] };
  }

  /**
   * Starts (or, if this task's state already exists and was left
   * mid-flight — e.g. by a crashed coordinator process — resumes)
   * automatic supervision. Never double-executes: a task already
   * `completed`/`failed` is returned as-is, and a `paused_*` task is
   * left alone until an explicit `resume()` call (which is itself the
   * "permitted by policy" check, not this method).
   */
  async start(taskId: string, options: StartAutoTaskOptions = {}): Promise<AutoTaskState> {
    const { state, settled } = await this.prepareStart(taskId, options);
    return settled ? state : this.continueFrom(state, options);
  }

  /**
   * Phase 4's non-blocking submission path (requirement #4): does exactly
   * the synchronous "load-or-create, then durably persist" half of
   * `start()` and returns — `settled: true` means there is nothing left
   * to run (already completed/failed/paused), `settled: false` means the
   * caller should run `continueFrom(state, options)`, which a daemon's
   * scheduler can do without awaiting it. This is a pure decomposition of
   * `start()`'s own existing logic, not new orchestration — `start()`
   * itself still does both halves when called directly, so every existing
   * caller/test is unaffected.
   */
  async prepareStart(taskId: string, options: StartAutoTaskOptions = {}): Promise<{ state: AutoTaskState; settled: boolean }> {
    const existing = await this.store.loadAutoTask(taskId);
    if (existing) {
      if (TERMINAL_STATES.has(existing.state) || PAUSED_STATES.has(existing.state)) return { state: existing, settled: true };
      return { state: existing, settled: false }; // coordinator-restart recovery: pick back up where the persisted state left off
    }

    const task = await this.store.loadTask(taskId);
    if (!task) throw new Error(`no task found with id "${taskId}" — create one first with \`handoff prepare\``);
    const lastHandoffId = task.handoffIds[task.handoffIds.length - 1];
    if (!lastHandoffId) throw new Error(`task "${taskId}" has no handoffs recorded`);
    const lastHandoff = await this.store.loadHandoff(lastHandoffId);
    if (!lastHandoff) throw new Error(`task "${taskId}" references a missing handoff "${lastHandoffId}"`);

    const now = Date.now();
    const initial: AutoTaskState = {
      taskId,
      state: "queued",
      currentProvider: lastHandoff.sourceProvider,
      currentHandoffId: lastHandoff.handoffId,
      attemptCount: 0,
      handoffCount: 0,
      startedAt: now,
      updatedAt: now,
      limits: {
        maxHandoffs: options.maxHandoffs ?? 6,
        maxAttempts: options.maxAttempts ?? 6,
        maxRuntimeMs: options.maxRuntimeMs ?? 60 * 60_000,
      },
      unknownAvailabilityPolicy: {
        allow: options.allowUnknownAvailability ?? false,
        maxAttempts: options.maxUnknownAttempts ?? 2,
        cooldownMs: options.unknownCooldownMs ?? 60_000,
      },
      unknownAttemptsByProvider: {},
      cooldowns: {},
      validationCommands: options.validationCommands ?? [],
      pinnedProvider: options.pinnedProvider ?? null,
      pendingDestination: null,
      failureReason: null,
      lastOutcome: null,
      lastHandoffStatus: null,
      transitions: [],
    };
    await this.store.saveAutoTask(initial);
    return { state: initial, settled: false };
  }

  /** Resuming a `paused_exhausted` task re-checks that provider's cooldown first — the pause is only lifted when the availability policy now permits it, not unconditionally. Resuming `paused_approval` always proceeds: calling this IS the human approval. */
  async resume(taskId: string, options: { suppliedObjective?: string; signal?: AbortSignal } = {}): Promise<AutoTaskState> {
    const { state, settled } = await this.prepareResume(taskId);
    return settled ? state : this.continueFrom(state, options);
  }

  /** Phase 4's non-blocking resume path — same split as `prepareStart`/`continueFrom`, for the same reason. */
  async prepareResume(taskId: string): Promise<{ state: AutoTaskState; settled: boolean }> {
    const state = await this.store.loadAutoTask(taskId);
    if (!state) throw new Error(`no automatic task state found for "${taskId}"`);
    if (!PAUSED_STATES.has(state.state)) return { state, settled: true };

    if (state.state === "paused_exhausted") {
      const candidate = state.pendingDestination ?? (state.currentProvider ? otherProvider(state.currentProvider) : null);
      const cooldown = candidate ? state.cooldowns[candidate] : undefined;
      if (candidate && isOnCooldown(cooldown)) {
        throw new Error(`task "${taskId}" is still on cooldown for ${candidate} until ${new Date(cooldown!.until).toISOString()} (${cooldown!.reason})`);
      }
    }

    // Re-enters at the top of the per-leg cycle (not straight back into
    // "selecting_provider") so ownership is re-checked fresh, not
    // assumed still valid just because the user asked to resume.
    const resumed = this.transition(state, "running", state.currentProvider, "resumed by user");
    await this.store.saveAutoTask(resumed);
    return { state: resumed, settled: false };
  }

  /** Runs the per-leg loop to completion/pause/failure from an already-persisted, non-settled state — the second half of `start()`/`resume()`, exposed so a daemon's scheduler can kick this off without awaiting it (requirement #4's "non-blocking"). */
  continueFrom(state: AutoTaskState, options: { suppliedObjective?: string; signal?: AbortSignal } = {}): Promise<AutoTaskState> {
    return this.runLoop(state, { suppliedObjective: options.suppliedObjective, signal: options.signal });
  }

  async pause(taskId: string): Promise<AutoTaskState> {
    const state = await this.store.loadAutoTask(taskId);
    if (!state) throw new Error(`no automatic task state found for "${taskId}"`);
    if (TERMINAL_STATES.has(state.state) || PAUSED_STATES.has(state.state)) return state;
    const next = this.transition(state, "paused_approval", state.currentProvider, "paused by user");
    await this.store.saveAutoTask(next);
    return next;
  }

  async stop(taskId: string): Promise<AutoTaskState> {
    const state = await this.store.loadAutoTask(taskId);
    if (!state) throw new Error(`no automatic task state found for "${taskId}"`);
    if (TERMINAL_STATES.has(state.state)) return state;
    let next = this.transition(state, "failed", state.currentProvider, "stopped by user");
    next = { ...next, failureReason: "stopped by user" };
    await this.store.saveAutoTask(next);
    return next;
  }

  async status(taskId: string): Promise<AutoTaskState | null> {
    return this.store.loadAutoTask(taskId);
  }

  async history(taskId: string): Promise<AutoTransition[]> {
    const state = await this.store.loadAutoTask(taskId);
    return state?.transitions ?? [];
  }

  private async runLoop(initial: AutoTaskState, run: { suppliedObjective?: string; signal?: AbortSignal } = {}): Promise<AutoTaskState> {
    let state = initial;
    while (!TERMINAL_STATES.has(state.state) && !PAUSED_STATES.has(state.state)) {
      state = await this.step(state, run);
      await this.store.saveAutoTask(state);
    }
    return state;
  }

  private async step(state: AutoTaskState, run: { suppliedObjective?: string; signal?: AbortSignal }): Promise<AutoTaskState> {
    switch (state.state) {
      case "queued":
        return this.transition(state, "running", state.currentProvider, "starting automatic supervision");

      case "running": {
        if (Date.now() - state.startedAt > state.limits.maxRuntimeMs) {
          return { ...this.transition(state, "failed", null, "exceeded maximum task runtime"), failureReason: "exceeded maximum task runtime" };
        }
        return this.transition(state, "checkpointing", state.currentProvider, "capturing current task/workspace state");
      }

      case "checkpointing": {
        const handoff = await this.store.loadHandoff(state.currentHandoffId!);
        if (!handoff) {
          const reason = `handoff "${state.currentHandoffId}" is missing from the store`;
          return { ...this.transition(state, "failed", null, reason), failureReason: reason };
        }
        return this.transition(state, "awaiting_ownership", state.currentProvider, "checking workspace ownership");
      }

      case "awaiting_ownership": {
        const handoff = (await this.store.loadHandoff(state.currentHandoffId!))!;
        const workspacePath = handoff.worktreePath ?? handoff.repoRoot;
        if (!workspacePath) {
          const reason = "handoff has no recorded repository or worktree path";
          return { ...this.transition(state, "failed", null, reason), failureReason: reason };
        }
        const assessment = await assessOwnership(workspacePath, this.lockManager, () => this.checkProviderActivity(workspacePath));
        if (assessment.state === "external_unknown") {
          const reason = assessment.signal
            ? `workspace ownership could not be confirmed safe (${assessment.signal.status}): ${assessment.signal.reason}`
            : "workspace ownership could not be confirmed safe";
          return this.transition(state, "paused_approval", state.currentProvider, reason);
        }
        return this.transition(state, "selecting_provider", state.currentProvider, `ownership established: ${assessment.state}`);
      }

      case "selecting_provider":
        return this.selectAndAdvance(state);

      case "handing_off":
        return this.handOffAndAdvance(state, run.suppliedObjective, run.signal);

      case "validating":
        return this.validateAndAdvance(state);

      default:
        return state; // completed/paused_*/failed never reach step() — runLoop stops first
    }
  }

  private async selectAndAdvance(state: AutoTaskState): Promise<AutoTaskState> {
    if (state.handoffCount >= state.limits.maxHandoffs) {
      const reason = `reached the maximum of ${state.limits.maxHandoffs} handoff(s) for this task`;
      return { ...this.transition(state, "failed", null, reason), failureReason: reason };
    }
    if (state.attemptCount >= state.limits.maxAttempts) {
      const reason = `reached the maximum of ${state.limits.maxAttempts} attempt(s) for this task`;
      return { ...this.transition(state, "failed", null, reason), failureReason: reason };
    }

    const selection = await selectAlternativeProvider(
      state.currentProvider!,
      state.pinnedProvider,
      this.getUsageStatus,
      state.cooldowns,
      state.unknownAvailabilityPolicy,
      state.unknownAttemptsByProvider,
    );

    if (selection.decision === "pause_exhausted") {
      const withCooldown = selection.status
        ? { ...state, cooldowns: { ...state.cooldowns, [selection.provider]: cooldownFromUsageStatus(selection.status, state.attemptCount) } }
        : state;
      return this.transition(withCooldown, "paused_exhausted", selection.provider, selection.reason);
    }
    if (selection.decision === "pause_unknown") {
      return this.transition(state, "paused_approval", selection.provider, selection.reason);
    }

    const priorUnknownAttempts = state.unknownAttemptsByProvider[selection.provider] ?? 0;
    const nextUnknownAttempts = {
      ...state.unknownAttemptsByProvider,
      [selection.provider]: selection.status?.classification === "unknown" ? priorUnknownAttempts + 1 : 0,
    };
    const withSelection: AutoTaskState = { ...state, pendingDestination: selection.provider, unknownAttemptsByProvider: nextUnknownAttempts };
    return this.transition(withSelection, "handing_off", selection.provider, selection.reason);
  }

  private async handOffAndAdvance(state: AutoTaskState, suppliedObjective: string | undefined, signal: AbortSignal | undefined): Promise<AutoTaskState> {
    const to = state.pendingDestination!;
    const currentHandoff = (await this.store.loadHandoff(state.currentHandoffId!))!;
    const failureSummary =
      state.lastOutcome && state.lastOutcome.kind !== "completed"
        ? `Previous attempt on ${state.currentProvider}: ${state.lastOutcome.kind}${state.lastOutcome.detail ? ` (${state.lastOutcome.detail})` : ""}`
        : null;
    const legHandoff = await getOrCreateNextLegHandoff(this.store, currentHandoff, failureSummary);

    const result = await this.engine.executeHandoff(legHandoff.handoffId, {
      to,
      suppliedObjective,
      forceLockOverride: false, // never automatically — requirement #2
      validationCommands: state.validationCommands,
      signal,
    });

    if (to === "claude" && result.lastExecutionResult) {
      for (const event of result.lastExecutionResult.events) this.claudeUsageMonitor.observe(event.raw);
    }

    const next: AutoTaskState = {
      ...state,
      attemptCount: state.attemptCount + 1,
      handoffCount: state.handoffCount + 1,
      currentHandoffId: legHandoff.handoffId,
      currentProvider: to,
      lastOutcome: result.attempt.outcome,
      lastHandoffStatus: result.handoff.status,
      pendingDestination: null,
    };
    return this.transition(next, "validating", to, result.blockedReason ?? result.attempt.outcome?.kind ?? "execution attempted");
  }

  private validateAndAdvance(state: AutoTaskState): AutoTaskState {
    const to = state.currentProvider!;

    if (state.lastHandoffStatus === "completed") {
      return this.transition(state, "completed", to, "destination completed and validation passed");
    }
    if (state.lastHandoffStatus === "failed_validation") {
      return this.transition(state, "paused_approval", to, "destination completed the work, but a configured validation command failed");
    }
    if (state.lastHandoffStatus === "blocked") {
      const reason = `handoff blocked unexpectedly during execution: ${state.failureReason ?? "unrecorded reason"}`;
      return { ...this.transition(state, "failed", to, reason), failureReason: reason };
    }

    const outcome = state.lastOutcome;
    if (outcome?.kind === "cancelled") {
      // Phase 4 requirement #5: distinguish a user-requested stop (new
      // terminal "stopped" state) from a user-requested pause (reuses the
      // existing "paused_approval" state — resuming it already works the
      // same way regardless of why it paused) — never "failed", since
      // this was asked for, not an error.
      if (outcome.detail === "stop") {
        return this.transition(state, "stopped", to, "stopped by explicit request while executing");
      }
      return this.transition(state, "paused_approval", to, `paused by explicit request while executing${outcome.detail ? ` (${outcome.detail})` : ""}`);
    }
    if (outcome?.kind === "auth_failed" || outcome?.kind === "permission_required") {
      return this.transition(state, "paused_approval", to, `stopping automatic retries: ${outcome.kind}${outcome.detail ? ` (${outcome.detail})` : ""}`);
    }
    if (outcome?.kind === "rate_limited") {
      const cooldown = cooldownFromOutcome(outcome, state.attemptCount);
      const withCooldown = { ...state, cooldowns: { ...state.cooldowns, [to]: cooldown } };
      return this.transition(withCooldown, "running", state.currentProvider, `rate limited; cooldown recorded for ${to}, will try the alternative provider next`);
    }
    // crashed / timed_out / invalid_output / unknown_error / context_exhausted — bounce to the other provider.
    return this.transition(state, "running", state.currentProvider, `execution did not complete (${outcome?.kind ?? "unknown"}); will try the alternative provider next`);
  }
}
