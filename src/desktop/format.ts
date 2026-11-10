import type { DesktopSessionRecord } from "./types.js";

export function formatDesktopSession(record: DesktopSessionRecord): string {
  const lines = [
    `[${record.provider}] ${record.sessionId} (${record.originatingApp})`,
    `  objective: ${record.objective}`,
    `  repoRoot: ${record.repoRoot ?? "unknown"}`,
    `  worktree: ${record.worktreePath ?? "(none / main worktree)"}`,
    `  ownership: ${record.ownershipStatus}`,
    `  observed activity: ${record.observedActivity}${record.lastConfirmedActivityAt ? ` (as of ${new Date(record.lastConfirmedActivityAt).toISOString()})` : ""}`,
    `  associated task: ${record.associatedTaskId ?? "(none yet)"}`,
    `  registered: ${new Date(record.registeredAt).toISOString()}`,
    "  evidence:",
  ];
  for (const e of record.evidence) lines.push(`    ${new Date(e.at).toISOString()} [${e.source}] ${e.detail}`);
  return lines.join("\n");
}
