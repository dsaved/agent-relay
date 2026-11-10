import { spawn } from "node:child_process";
import type { GitFileStatus, HandoffSnapshot, SessionAssociation } from "./types.js";

function runGit(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    proc.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    proc.once("error", () => resolve(null));
    proc.once("exit", (code) => resolve(code === 0 ? stdout : null));
  });
}

function parsePorcelainStatus(output: string): GitFileStatus[] {
  return output
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3).trim() }));
}

/**
 * Builds a read-only snapshot of a session for a *possible* future
 * handoff. It runs exactly three read-only `git` plumbing commands
 * (status/branch/HEAD) against the session's own worktree (or repo root,
 * if it has no separate worktree) and reports the provider's own
 * metadata verbatim — it never writes, resets, stages, commits, or
 * otherwise touches the repository, and it never runs the project's own
 * test/build commands (see docs/SESSION_DISCOVERY.md for why: that would
 * be an unrequested side effect on someone's working tree, not a read).
 *
 * Deliberately NOT done here: inferring "done" or "not done" from the
 * presence/absence of modified files. A clean tree can mean finished —
 * or abandoned before starting. A dirty one can mean mid-task — or
 * unrelated scratch edits. `availableProgressInformation` and
 * `validationResults` are reported only when some actual tool already
 * produced them; this function never fabricates a verdict to fill the
 * gap.
 */
export async function prepareHandoffSnapshot(session: SessionAssociation): Promise<HandoffSnapshot> {
  const workdir = session.worktreePath ?? session.repoRoot;
  const git = workdir
    ? await (async () => {
        const [status, branch, head] = await Promise.all([
          runGit(["status", "--porcelain=v1"], workdir),
          runGit(["branch", "--show-current"], workdir),
          runGit(["rev-parse", "HEAD"], workdir),
        ]);
        if (status === null && branch === null && head === null) return null; // not a git repo we could read at all
        return {
          branch: branch ? branch.trim() || null : null,
          headSha: head ? head.trim() : null,
          files: status ? parsePorcelainStatus(status) : [],
        };
      })()
    : null;

  return {
    sourceSessionId: session.sessionId,
    provider: session.provider,
    repoRoot: session.repoRoot,
    worktreePath: session.worktreePath,
    git,
    availableTaskDescription: session.title,
    availableProgressInformation:
      session.provider === "codex" ? { lastKnownStatus: session.status, providerGitInfo: session.providerGitInfo } : null,
    validationResults: null,
    generatedAt: Date.now(),
  };
}
