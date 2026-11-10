import type { HandoffRecord, Task } from "./types.js";

export function formatHandoffRecord(h: HandoffRecord): string {
  const lines = [
    `Handoff ${h.handoffId} (task ${h.taskId})`,
    `  status: ${h.status}`,
    `  ${h.sourceProvider} -> ${h.destinationProvider ?? "(not yet targeted)"}`,
    `  source session: ${h.sourceSessionId}`,
    `  repoRoot: ${h.repoRoot ?? "unknown"}`,
    `  worktree: ${h.worktreePath ?? "(none / main worktree)"}`,
    `  branch: ${h.branch ?? "unknown"} @ ${h.commitSha ?? "unknown"}`,
    `  objective: ${h.originalTaskObjective ?? "(none recorded — required before execute)"}`,
    `  files at prepare time: ${h.files.length === 0 ? "clean" : h.files.map((f) => `${f.code} ${f.path}`).join(", ")}`,
  ];
  if (h.handoffReason) lines.push(`  reason: ${h.handoffReason}`);
  if (h.attempts.length === 0) {
    lines.push("  attempts: none yet");
  } else {
    lines.push(`  attempts (${h.attempts.length}):`);
    h.attempts.forEach((a, i) => {
      lines.push(
        `    #${i + 1} at ${new Date(a.attemptedAt).toISOString()} -> ${a.destinationProvider} [${a.usageDecision}]` +
          (a.outcome ? `: ${a.outcome.kind}${a.outcome.detail ? ` (${a.outcome.detail})` : ""}` : " (blocked before execution)") +
          (a.destinationSessionId ? `, destSessionId=${a.destinationSessionId}` : "") +
          (a.lockOverrideUsed ? ", LOCK OVERRIDE USED" : "") +
          (a.validationResults ? `, validation: ${a.validationResults.map((v) => `${v.command}=${v.passed ? "pass" : "fail"}`).join(", ")}` : ""),
      );
      if (a.ownershipVerification.activityStatus) {
        lines.push(`        ownership check: ${a.ownershipVerification.activityStatus} — ${a.ownershipVerification.activityReason}`);
      }
      if (a.ownershipVerification.lockRecoveredFromCrash) {
        lines.push("        lock recovered from a crashed prior holder");
      }
    });
  }
  return lines.join("\n");
}

export function formatTask(task: Task, handoffs: HandoffRecord[]): string {
  const lines = [`Task ${task.taskId}`, `  created: ${new Date(task.createdAt).toISOString()}`, `  handoffs (${task.handoffIds.length}):`];
  for (const h of handoffs) {
    lines.push(`  - ${h.handoffId}: ${h.sourceProvider} -> ${h.destinationProvider ?? "?"} [${h.status}]`);
  }
  return lines.join("\n");
}
