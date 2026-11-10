import type { HandoffRecord } from "./types.js";

/**
 * Builds the instruction handed to the destination provider. Every line
 * comes directly from the handoff package's own fields — nothing here
 * is generated or inferred content, only templating of what's already
 * there (or explicitly supplied at execute time).
 */
export function buildContinuationInstruction(record: HandoffRecord, objective: string): string {
  const lines: string[] = [
    `You are continuing unfinished work that was started in a different coding assistant (${record.sourceProvider}). Do not recreate it from scratch — inspect the current repository state first, then continue.`,
    "",
    `Task objective: ${objective}`,
  ];

  if (record.branch || record.commitSha) {
    lines.push("", `Current branch: ${record.branch ?? "(unknown)"}`, `Current commit: ${record.commitSha ?? "(unknown)"}`);
  }

  if (record.files.length > 0) {
    lines.push("", "Modified/untracked files already present in the working tree (do not assume these mean the task is finished OR unfinished — just be aware of them):");
    for (const f of record.files) lines.push(`  ${f.code} ${f.path}`);
  } else {
    lines.push("", "The working tree was clean when this handoff was prepared.");
  }

  if (record.availableImplementationProgress) {
    lines.push("", `Progress reported by the source provider: ${JSON.stringify(record.availableImplementationProgress)}`);
  }

  if (record.remainingImplementationSteps.length > 0) {
    lines.push("", "Remaining steps, as reported by whoever prepared this handoff:");
    for (const step of record.remainingImplementationSteps) lines.push(`  - ${step}`);
  }

  if (record.knownErrors.length > 0) {
    lines.push("", "Known errors reported so far:");
    for (const e of record.knownErrors) lines.push(`  - ${e}`);
  }

  if (record.handoffReason) {
    lines.push("", `Reason for this handoff: ${record.handoffReason}`);
  }

  return lines.join("\n");
}

/** Sent to a session being resumed mid-task — it already has full context, so it gets a nudge, not the whole package again. */
export function buildResumeNudge(): string {
  return "Continue the previous implementation task from exactly where you left off. Do not restart or recreate work that's already done.";
}
