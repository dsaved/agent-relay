import { AutomaticHandoffCoordinator, type StartAutoTaskOptions } from "../auto/coordinator.js";
import { HandoffStore } from "../handoff/store.js";
import type { AutoTaskState } from "../auto/types.js";
import type { SessionProvider } from "../sessions/types.js";
import { notifyProviderChoice, notifyReadyToOpen } from "../notify/terminalNotifier.js";
import type { DaemonLogger } from "./log.js";

interface InFlightEntry {
  controller: AbortController;
  promise: Promise<AutoTaskState>;
}

/** Set only on a resume that itself supplied a provider pin — distinguishes "a leg just executed, maybe worth a ready-to-view notification" from the initial settlement that's merely asking for a choice. */
type SettleOrigin = "pin-resume" | undefined;

export interface SubmitResult {
  /** The state as of the moment the request was durably recorded — never the final settled state; a caller must poll `inspect`/`list` for that. */
  state: AutoTaskState;
  /** True when something was actually kicked off to run in the background; false when the task was already settled (completed/failed/paused) and nothing new started. */
  running: boolean;
}

/**
 * Requirement #4's persistent task scheduler: moves `AutomaticHandoffCoordinator`'s
 * execution into this daemon process, tracked by an in-memory
 * `Map<taskId, AbortController>` so a later pause/stop (requirement #5)
 * can interrupt a genuinely in-flight run, not just mutate a state file.
 * Reuses the coordinator's own `prepareStart`/`prepareResume`/`continueFrom`
 * split (Phase 4's one small addition to `src/auto/coordinator.ts`) —
 * this scheduler implements no orchestration logic of its own, only
 * acceptance, tracking, and cancellation routing.
 */
export class TaskScheduler {
  private readonly inFlight = new Map<string, InFlightEntry>();

  constructor(
    private readonly coordinator: AutomaticHandoffCoordinator,
    private readonly store: HandoffStore,
    private readonly maxConcurrentTasks: number,
    private readonly logger?: DaemonLogger,
    private readonly notifyChoice: typeof notifyProviderChoice = notifyProviderChoice,
    private readonly notifyReady: typeof notifyReadyToOpen = notifyReadyToOpen,
  ) {}

  isRunning(taskId: string): boolean {
    return this.inFlight.has(taskId);
  }

  listRunning(): string[] {
    return [...this.inFlight.keys()];
  }

  /** Waits for every currently in-flight task to reach its own settled outcome — never aborts anything; used by a graceful daemon shutdown that wants to let bounded executions finish naturally (see src/daemon/process.ts's `stop()`). */
  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()].map((entry) => entry.promise));
  }

  private track(taskId: string, controller: AbortController, promise: Promise<AutoTaskState>, origin?: SettleOrigin): void {
    this.inFlight.set(taskId, { controller, promise });
    void promise.then(
      (state) => {
        // `inFlight` cleanup happens synchronously, first, in both
        // branches below — before `handleSettled`'s own async body ever
        // runs. It calls `this.resume()` recursively for this same
        // taskId when a notification picks a provider; if the entry were
        // still present (e.g. behind a `.finally()` further down the
        // chain), that recursive call would see "already in flight" and
        // silently no-op instead of actually resuming.
        this.inFlight.delete(taskId);
        void this.handleSettled(taskId, state, origin);
      },
      (err: unknown) => {
        this.inFlight.delete(taskId);
        // A rejected continuation must still free the slot above — but an
        // exception thrown deep inside the coordinator's loop (as opposed
        // to a normal paused/failed/stopped *outcome*, which never
        // throws) would otherwise be silently swallowed, leaving the
        // task's last persisted state looking merely "stuck" with no
        // record of why. Logged here so it's observable instead.
        void this.logger?.write("task_lifecycle", { taskId, event: "continuation_threw", error: err instanceof Error ? err.message : String(err) });
      },
    );
  }

  /**
   * Phase 9's daemon-only notification wiring — never allowed to throw
   * out of here and never allowed to affect the coordinator's own
   * persisted state, only to observe it after the fact. Two cases:
   * settling on `pendingProviderChoice` asks which provider to continue
   * on and, if the person picks one, resumes the task itself (no extra
   * CLI round trip needed); settling after a pin-driven resume that
   * actually ran a leg just announces it's ready to view.
   */
  private async handleSettled(taskId: string, state: AutoTaskState, origin?: SettleOrigin): Promise<void> {
    try {
      if (origin === "pin-resume") {
        if (state.lastHandoffStatus && state.currentHandoffId && state.currentProvider) {
          await this.notifyReady(state.currentHandoffId, state.currentProvider);
        }
        return;
      }
      if (state.state === "paused_approval" && state.pendingProviderChoice && state.currentProvider) {
        const picked = await this.notifyChoice(state.pendingProviderChoice, state.currentProvider, taskId);
        if (picked) await this.resume(taskId, undefined, picked);
      }
    } catch (err) {
      await this.logger?.write("task_lifecycle", { taskId, event: "notification_failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Non-blocking: returns once the request is accepted and durably recorded (the coordinator's own `prepareStart` persistence), without waiting for the task to actually finish. */
  async submit(taskId: string, options: StartAutoTaskOptions = {}): Promise<SubmitResult> {
    if (this.inFlight.has(taskId)) {
      const existing = await this.store.loadAutoTask(taskId);
      return { state: existing!, running: true };
    }
    if (this.inFlight.size >= this.maxConcurrentTasks) {
      throw new Error(`refusing to start task "${taskId}": already at the configured maximum of ${this.maxConcurrentTasks} concurrent task(s)`);
    }

    const { state, settled } = await this.coordinator.prepareStart(taskId, options);
    await this.logger?.write("task_lifecycle", { taskId, event: "submitted", state: state.state });
    if (settled) return { state, running: false };

    const controller = new AbortController();
    const promise = this.coordinator.continueFrom(state, { suppliedObjective: options.suppliedObjective, signal: controller.signal });
    this.track(taskId, controller, promise);
    return { state, running: true };
  }

  async resume(taskId: string, suppliedObjective?: string, pin?: SessionProvider): Promise<SubmitResult> {
    if (this.inFlight.has(taskId)) {
      const existing = await this.store.loadAutoTask(taskId);
      return { state: existing!, running: true };
    }
    const { state, settled } = await this.coordinator.prepareResume(taskId, pin);
    await this.logger?.write("task_lifecycle", { taskId, event: "resumed", state: state.state });
    if (settled) return { state, running: false };

    const controller = new AbortController();
    const promise = this.coordinator.continueFrom(state, { suppliedObjective, signal: controller.signal });
    this.track(taskId, controller, promise, pin ? "pin-resume" : undefined);
    return { state, running: true };
  }

  /**
   * Requirement #5: if the task is actually executing in this daemon
   * right now, aborts the real in-flight run (propagated through
   * `HandoffEngine`/the execution adapter/`spawnRun`'s process-group
   * kill — see src/execution/spawnRun.ts). If it isn't (nothing tracked
   * for this id), falls through to the coordinator's existing direct
   * `pause()`/`stop()` store mutation — same unified outcome either way,
   * never two different behaviors depending on which daemon happens to
   * be asked.
   */
  async requestPause(taskId: string): Promise<AutoTaskState> {
    const entry = this.inFlight.get(taskId);
    if (entry) {
      entry.controller.abort("pause");
      await this.logger?.write("task_lifecycle", { taskId, event: "pause_requested_in_flight" });
      return entry.promise;
    }
    await this.logger?.write("task_lifecycle", { taskId, event: "pause_requested_direct" });
    return this.coordinator.pause(taskId);
  }

  async requestStop(taskId: string): Promise<AutoTaskState> {
    const entry = this.inFlight.get(taskId);
    if (entry) {
      entry.controller.abort("stop");
      await this.logger?.write("task_lifecycle", { taskId, event: "stop_requested_in_flight" });
      return entry.promise;
    }
    await this.logger?.write("task_lifecycle", { taskId, event: "stop_requested_direct" });
    return this.coordinator.stop(taskId);
  }
}
