import { AutomaticHandoffCoordinator, type StartAutoTaskOptions } from "../auto/coordinator.js";
import { HandoffStore } from "../handoff/store.js";
import type { AutoTaskState } from "../auto/types.js";
import type { DaemonLogger } from "./log.js";

interface InFlightEntry {
  controller: AbortController;
  promise: Promise<AutoTaskState>;
}

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

  private track(taskId: string, controller: AbortController, promise: Promise<AutoTaskState>): void {
    this.inFlight.set(taskId, { controller, promise });
    void promise
      .catch((err: unknown) => {
        // A rejected continuation must still free the slot below — but an
        // exception thrown deep inside the coordinator's loop (as opposed
        // to a normal paused/failed/stopped *outcome*, which never
        // throws) would otherwise be silently swallowed, leaving the
        // task's last persisted state looking merely "stuck" with no
        // record of why. Logged here so it's observable instead.
        void this.logger?.write("task_lifecycle", { taskId, event: "continuation_threw", error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => this.inFlight.delete(taskId));
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

  async resume(taskId: string, suppliedObjective?: string): Promise<SubmitResult> {
    if (this.inFlight.has(taskId)) {
      const existing = await this.store.loadAutoTask(taskId);
      return { state: existing!, running: true };
    }
    const { state, settled } = await this.coordinator.prepareResume(taskId);
    await this.logger?.write("task_lifecycle", { taskId, event: "resumed", state: state.state });
    if (settled) return { state, running: false };

    const controller = new AbortController();
    const promise = this.coordinator.continueFrom(state, { suppliedObjective, signal: controller.signal });
    this.track(taskId, controller, promise);
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
