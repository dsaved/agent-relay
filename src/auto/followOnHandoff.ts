import { createHandoffRecord } from "../handoff/prepare.js";
import { HandoffStore } from "../handoff/store.js";
import type { HandoffRecord } from "../handoff/types.js";

/**
 * Picks the handoff record the coordinator should execute next.
 *
 * - If the current handoff has never been targeted yet
 *   (`destinationProvider === null` — true for leg 1, the record
 *   `handoff prepare` already created), it's reused as-is: no reason to
 *   create a second record for the very first attempt.
 * - Otherwise (this handoff already ran once, successfully or not), a
 *   fresh `HandoffRecord` is built via Phase 2B's own
 *   `createHandoffRecord()` — re-reading the *current* git state (so
 *   whatever the previous destination actually left behind is captured
 *   fresh, not assumed), attached to the same `taskId`, with the
 *   previous leg's `destinationProvider` as this leg's new source and
 *   its last recorded `destinationSessionId` as the new source session.
 *   `originalTaskObjective` is carried forward unchanged — this never
 *   invents a new one.
 */
export async function getOrCreateNextLegHandoff(
  store: HandoffStore,
  currentHandoff: HandoffRecord,
  failureSummary: string | null,
): Promise<HandoffRecord> {
  if (!currentHandoff.destinationProvider) {
    return currentHandoff;
  }

  const lastAttempt = currentHandoff.attempts[currentHandoff.attempts.length - 1];
  const syntheticSource = {
    provider: currentHandoff.destinationProvider,
    sessionId: lastAttempt?.destinationSessionId ?? currentHandoff.sourceSessionId,
    projectDir: currentHandoff.worktreePath ?? currentHandoff.repoRoot,
    status: "idle" as const,
    lastActivity: null,
    discoverySource: "auto-coordinator:follow-on-leg",
    pid: null,
    title: currentHandoff.originalTaskObjective,
    providerGitInfo: null,
    repoRoot: currentHandoff.repoRoot,
    worktreePath: currentHandoff.worktreePath,
    workspaceAccessible: true,
  };

  const { handoff } = await createHandoffRecord(syntheticSource, { taskId: currentHandoff.taskId, handoffReason: failureSummary });
  handoff.knownErrors.push(...currentHandoff.knownErrors);
  if (failureSummary) handoff.knownErrors.push(failureSummary);
  await store.saveHandoff(handoff);

  const task = await store.loadTask(currentHandoff.taskId);
  if (task && !task.handoffIds.includes(handoff.handoffId)) {
    task.handoffIds.push(handoff.handoffId);
    await store.saveTask(task);
  }

  return handoff;
}
