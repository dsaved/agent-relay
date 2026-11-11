import { createHandoffRecord } from "../handoff/prepare.js";
import { HandoffStore } from "../handoff/store.js";
import type { HandoffRecord } from "../handoff/types.js";

/**
 * Picks the handoff record the coordinator should execute next.
 *
 * - If this handoff has never actually recorded an attempt yet
 *   (`attempts.length === 0`), it's reused as-is — this is still "the
 *   same leg", whether that's because it's genuinely leg 1 (the record
 *   `handoff prepare` already created, `destinationProvider` still
 *   null), or because a prior run of *this exact leg* set
 *   `destinationProvider` and persisted it (inside
 *   `HandoffEngine.executeHandoff`, right after acquiring the workspace
 *   lock) and then crashed before ever reaching `adapter.run()` — a real
 *   scenario this project's own crash-recovery integration test caught:
 *   checking `destinationProvider` alone would wrongly treat that as
 *   "leg 1 already ran," build a *new* record whose synthetic source
 *   provider is the very provider it's about to be handed back to, and
 *   `HandoffEngine` would then correctly refuse it as a same-provider
 *   handoff — not a new leg, just this one, continuing. `executeHandoff`
 *   itself already tolerates `destinationProvider` matching the
 *   requested `to` (it only refuses a *different* one), so simply
 *   reusing the record here is enough.
 * - Otherwise (an attempt was actually recorded — completed, crashed,
 *   timed out, whatever), a
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
  if (currentHandoff.attempts.length === 0) {
    return currentHandoff;
  }
  // An attempt was recorded, so `executeHandoff` must have reached the
  // point where it sets `destinationProvider` (right at its own start) —
  // never null here; asserted, not re-guessed.
  if (!currentHandoff.destinationProvider) {
    throw new Error(`handoff "${currentHandoff.handoffId}" has a recorded attempt but no destinationProvider — inconsistent state`);
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
