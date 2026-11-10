import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DiscoveredSession, ProjectGroup, SessionAssociation, WorktreeInfo } from "./types.js";

function runGit(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    proc.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    proc.once("error", () => resolve(null));
    proc.once("exit", (code) => resolve(code === 0 ? stdout.trim() : null));
  });
}

/**
 * Repository root + worktree detection, using only `git` plumbing
 * commands (no credential files, no provider-specific state). A linked
 * worktree's `.git` is a *file* pointing at the real one inside the main
 * worktree's `.git/worktrees/<name>`; the main worktree's `.git` is a
 * directory. That's a cheaper and more reliable test than parsing
 * `git worktree list` output.
 */
export async function detectWorktreeInfo(cwd: string): Promise<WorktreeInfo> {
  const toplevel = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!toplevel) return { repoRoot: null, worktreePath: null };

  let isLinkedWorktree: boolean;
  try {
    isLinkedWorktree = !(await stat(join(toplevel, ".git"))).isDirectory();
  } catch {
    return { repoRoot: null, worktreePath: null }; // `.git` missing entirely — not a usable repo
  }

  if (!isLinkedWorktree) {
    return { repoRoot: toplevel, worktreePath: null };
  }

  const commonDir = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  // A repo's common `.git` dir is directly inside its root.
  return { repoRoot: commonDir ? dirname(commonDir) : null, worktreePath: toplevel };
}

/** `false` only when the directory genuinely can't be statted; `null` when there's no `projectDir` to check at all. */
export async function isWorkspaceAccessible(projectDir: string | null): Promise<boolean | null> {
  if (!projectDir) return null;
  try {
    await stat(projectDir);
    return true;
  } catch {
    return false;
  }
}

/** Removes repeat `${provider}:${sessionId}` records, keeping the first occurrence. */
export function dedupeSessions(sessions: DiscoveredSession[]): DiscoveredSession[] {
  const seen = new Set<string>();
  const result: DiscoveredSession[] = [];
  for (const session of sessions) {
    const key = `${session.provider}:${session.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(session);
  }
  return result;
}

/**
 * Associates each session with its repo root/worktree and workspace
 * accessibility. Sessions are never merged or treated as "the same task"
 * just because they end up grouped under the same `repoRoot` — grouping
 * is purely a view of the data, not an inference about relatedness.
 */
export async function associateSessions(sessions: DiscoveredSession[]): Promise<SessionAssociation[]> {
  const deduped = dedupeSessions(sessions);
  return Promise.all(
    deduped.map(async (session) => {
      const workspaceAccessible = await isWorkspaceAccessible(session.projectDir);
      const worktreeInfo = workspaceAccessible ? await detectWorktreeInfo(session.projectDir as string) : { repoRoot: null, worktreePath: null };
      return { ...session, ...worktreeInfo, workspaceAccessible };
    }),
  );
}

export function groupByProject(associations: SessionAssociation[]): ProjectGroup[] {
  const groups = new Map<string | null, SessionAssociation[]>();
  for (const assoc of associations) {
    const key = assoc.repoRoot;
    const list = groups.get(key) ?? [];
    list.push(assoc);
    groups.set(key, list);
  }
  return Array.from(groups.entries()).map(([repoRoot, groupSessions]) => ({ repoRoot, sessions: groupSessions }));
}
