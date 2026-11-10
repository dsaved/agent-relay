import type { HandoffSnapshot, SessionAssociation } from "./types.js";

export function formatSessionLine(s: SessionAssociation): string {
  const activity = s.lastActivity ? new Date(s.lastActivity).toISOString() : "unknown";
  const workspace = s.workspaceAccessible === false ? " [WORKSPACE MISSING]" : "";
  return [
    `[${s.provider}] ${s.sessionId}`,
    `  status: ${s.status}${workspace}`,
    `  project: ${s.projectDir ?? "unknown"}`,
    `  repoRoot: ${s.repoRoot ?? "unknown"}`,
    `  worktree: ${s.worktreePath ?? "(none / main worktree)"}`,
    `  lastActivity: ${activity}`,
    `  discoverySource: ${s.discoverySource}`,
    s.title ? `  title: ${s.title}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function formatHandoffSnapshot(h: HandoffSnapshot): string {
  const lines = [
    `Handoff snapshot for ${h.provider}:${h.sourceSessionId}`,
    `  generated: ${new Date(h.generatedAt).toISOString()}`,
    `  repoRoot: ${h.repoRoot ?? "unknown"}`,
    `  worktree: ${h.worktreePath ?? "(none / main worktree)"}`,
    `  task description: ${h.availableTaskDescription ?? "(none reported)"}`,
  ];

  if (h.git) {
    lines.push(`  branch: ${h.git.branch ?? "(detached or unknown)"}`, `  HEAD: ${h.git.headSha ?? "unknown"}`);
    if (h.git.files.length === 0) {
      lines.push("  working tree: clean (no modified/untracked files)");
    } else {
      lines.push(`  working tree: ${h.git.files.length} changed file(s):`);
      for (const f of h.git.files) lines.push(`    ${f.code} ${f.path}`);
    }
  } else {
    lines.push("  git status: unavailable (not a readable git repository)");
  }

  lines.push(
    `  progress info: ${h.availableProgressInformation ? JSON.stringify(h.availableProgressInformation) : "(none reported)"}`,
    `  validation results: ${h.validationResults ? JSON.stringify(h.validationResults) : "(none available — this phase does not run tests itself)"}`,
    "",
    "  Note: file changes above are facts, not a completeness judgment —",
    "  see docs/SESSION_DISCOVERY.md for why this snapshot never infers",
    "  whether the task is done.",
  );
  return lines.join("\n");
}
