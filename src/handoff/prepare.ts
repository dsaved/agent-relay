import { randomUUID } from "node:crypto";
import { prepareHandoffSnapshot } from "../sessions/handoff.js";
import type { SessionAssociation } from "../sessions/types.js";
import type { HandoffRecord, Task } from "./types.js";

export interface PrepareHandoffOptions {
  /** Attach to an existing task (e.g. a second leg of a back-and-forth) instead of starting a new one. */
  taskId?: string;
  handoffReason?: string | null;
}

/**
 * Builds a durable HandoffRecord from a discovered session (Phase 2A).
 * Read-only with respect to the source session/repository — the only
 * writes this performs are the three `git` reads already used by
 * Phase 2A's `prepareHandoffSnapshot` (status/branch/HEAD); it never
 * invents `originalTaskObjective`, progress, or remaining steps that
 * weren't already there.
 */
export async function createHandoffRecord(session: SessionAssociation, options: PrepareHandoffOptions = {}): Promise<{ task: Task; handoff: HandoffRecord }> {
  const snapshot = await prepareHandoffSnapshot(session);
  const now = Date.now();
  const taskId = options.taskId ?? randomUUID();

  const handoff: HandoffRecord = {
    handoffId: randomUUID(),
    taskId,
    sourceProvider: snapshot.provider,
    destinationProvider: null,
    sourceSessionId: snapshot.sourceSessionId,
    repoRoot: snapshot.repoRoot,
    worktreePath: snapshot.worktreePath,
    originalTaskObjective: snapshot.availableTaskDescription,
    branch: snapshot.git?.branch ?? null,
    commitSha: snapshot.git?.headSha ?? null,
    files: snapshot.git?.files ?? [],
    availableImplementationProgress: snapshot.availableProgressInformation,
    validationResults: null,
    knownErrors: [],
    remainingImplementationSteps: [],
    handoffReason: options.handoffReason ?? null,
    createdAt: now,
    status: "pending",
    attempts: [],
  };

  const task: Task = { taskId, createdAt: now, handoffIds: [handoff.handoffId] };
  return { task, handoff };
}
