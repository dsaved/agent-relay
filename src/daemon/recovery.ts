import { HandoffStore } from "../handoff/store.js";
import { WorkspaceLockManager, isPidAlive } from "../handoff/lock.js";
import type { AutoState } from "../auto/types.js";
import { TaskScheduler } from "./scheduler.js";
import type { DaemonLogger } from "./log.js";

const SETTLED_STATES: ReadonlySet<AutoState> = new Set(["completed", "failed", "stopped", "paused_exhausted", "paused_approval"]);

export type RecoveryDecisionKind = "resumed" | "left_alone" | "skipped_corrupted";

export interface RecoveryDecision {
  taskId: string;
  priorState: AutoState | null;
  decision: RecoveryDecisionKind;
  reason: string;
}

/**
 * Requirement #6's crash recovery, run once before the daemon opens its
 * socket. Never assumes an old PID still belongs to the original
 * worker — a lock whose recorded holder is alive is left alone
 * unconditionally, whoever it turns out to actually be (same honestly-
 * stated limitation Phase 2C already documented for `isPidAlive`, not a
 * new one). A corrupted task-state file is logged and skipped, never
 * fatal to startup.
 */
export async function runCrashRecovery(store: HandoffStore, scheduler: TaskScheduler, lockManager: WorkspaceLockManager, logger?: DaemonLogger): Promise<RecoveryDecision[]> {
  const decisions: RecoveryDecision[] = [];
  const taskIds = await store.listAutoTaskIds();

  for (const taskId of taskIds) {
    let state;
    try {
      state = await store.loadAutoTask(taskId);
    } catch (err) {
      const decision: RecoveryDecision = { taskId, priorState: null, decision: "skipped_corrupted", reason: err instanceof Error ? err.message : String(err) };
      decisions.push(decision);
      await logger?.write("crash_recovery", decision);
      continue;
    }
    if (!state) continue; // genuinely absent (e.g. listed, then deleted, between the list and the load) — nothing to recover

    if (SETTLED_STATES.has(state.state)) {
      const decision: RecoveryDecision = { taskId, priorState: state.state, decision: "left_alone", reason: `already ${state.state} — nothing to recover` };
      decisions.push(decision);
      await logger?.write("crash_recovery", decision);
      continue;
    }

    const handoff = state.currentHandoffId ? await store.loadHandoff(state.currentHandoffId) : null;
    const workspacePath = handoff?.worktreePath ?? handoff?.repoRoot ?? null;
    if (!workspacePath) {
      const decision: RecoveryDecision = { taskId, priorState: state.state, decision: "left_alone", reason: "no recorded workspace path to verify ownership against" };
      decisions.push(decision);
      await logger?.write("crash_recovery", decision);
      continue;
    }

    const lockRecord = await lockManager.readLockRecord(workspacePath);
    const liveHolder = lockRecord && isPidAlive(lockRecord.holderPid);
    if (liveHolder) {
      const decision: RecoveryDecision = { taskId, priorState: state.state, decision: "left_alone", reason: `workspace lock is held by a live process (pid ${lockRecord.holderPid}) — refusing to resume under uncertainty, never assuming it's this restarted daemon` };
      decisions.push(decision);
      await logger?.write("crash_recovery", decision);
      continue;
    }

    // No lock at all, or one whose recorded holder is confirmed dead —
    // safe to pick back up. `scheduler.submit()` reuses the coordinator's
    // own existing restart-recovery logic (Phase 3A, unchanged): it
    // resumes from exactly the persisted state, never re-running a leg
    // that already completed.
    await scheduler.submit(taskId);
    const decision: RecoveryDecision = {
      taskId,
      priorState: state.state,
      decision: "resumed",
      reason: lockRecord ? `prior lock holder (pid ${lockRecord.holderPid}) is confirmed dead` : "no workspace lock was recorded",
    };
    decisions.push(decision);
    await logger?.write("crash_recovery", decision);
  }

  return decisions;
}
