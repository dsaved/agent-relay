import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  associateSessions,
  dedupeSessions,
  detectWorktreeInfo,
  groupByProject,
  isWorkspaceAccessible,
} from "../src/sessions/projectAssociation.js";
import type { DiscoveredSession } from "../src/sessions/types.js";
import { git, withTempRepo } from "./helpers/tempGitRepo.js";

function makeSession(overrides: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    provider: "claude",
    sessionId: "s-1",
    projectDir: null,
    status: "idle",
    lastActivity: null,
    discoverySource: "test",
    pid: null,
    title: null,
    providerGitInfo: null,
    ...overrides,
  };
}

test("detectWorktreeInfo: main worktree -> repoRoot set, worktreePath null", async () => {
  await withTempRepo(async (repoRoot) => {
    const info = await detectWorktreeInfo(repoRoot);
    assert.equal(info.repoRoot, repoRoot);
    assert.equal(info.worktreePath, null);
  });
});

test("detectWorktreeInfo: linked worktree -> repoRoot is the main repo, worktreePath is the linked path", async () => {
  await withTempRepo(async (repoRoot) => {
    const worktreePath = join(repoRoot, "..", "agent-relay-assoc-wt-" + Date.now());
    git(["worktree", "add", "-b", "wt-branch", worktreePath], repoRoot);
    try {
      const info = await detectWorktreeInfo(worktreePath);
      assert.equal(info.repoRoot, repoRoot);
      assert.equal(info.worktreePath, worktreePath);
    } finally {
      git(["worktree", "remove", "--force", worktreePath], repoRoot);
    }
  });
});

test("detectWorktreeInfo: not a git repo at all -> both null, no throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-not-git-"));
  try {
    const info = await detectWorktreeInfo(dir);
    assert.deepEqual(info, { repoRoot: null, worktreePath: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isWorkspaceAccessible: true for a real directory, false for a missing one, null for no path", async () => {
  await withTempRepo(async (repoRoot) => {
    assert.equal(await isWorkspaceAccessible(repoRoot), true);
  });
  assert.equal(await isWorkspaceAccessible("/definitely/does/not/exist/agent-relay"), false);
  assert.equal(await isWorkspaceAccessible(null), null);
});

test("dedupeSessions: collapses repeat provider:sessionId pairs, keeps distinct ones", () => {
  const a = makeSession({ sessionId: "dup", title: "first seen" });
  const b = makeSession({ sessionId: "dup", title: "duplicate" });
  const c = makeSession({ sessionId: "other" });
  const result = dedupeSessions([a, b, c]);
  assert.equal(result.length, 2);
  assert.equal(result.find((s) => s.sessionId === "dup")?.title, "first seen");
});

test("associateSessions: missing workspace is detected and does not block association of other sessions", async () => {
  const sessions = [makeSession({ sessionId: "missing", projectDir: "/definitely/does/not/exist/agent-relay" })];
  const result = await associateSessions(sessions);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.workspaceAccessible, false);
  assert.equal(result[0]?.repoRoot, null);
});

test("associateSessions + groupByProject: two sessions in the same repo are grouped together but remain two distinct entries, never merged", async () => {
  await withTempRepo(async (repoRoot) => {
    const sessions = [
      makeSession({ provider: "claude", sessionId: "s-a", projectDir: repoRoot }),
      makeSession({ provider: "codex", sessionId: "s-b", projectDir: repoRoot }),
    ];
    const associated = await associateSessions(sessions);
    const groups = groupByProject(associated);

    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.repoRoot, repoRoot);
    assert.equal(groups[0]?.sessions.length, 2);
    const ids = groups[0]?.sessions.map((s) => s.sessionId).sort();
    assert.deepEqual(ids, ["s-a", "s-b"]);
  });
});

test("groupByProject: sessions with no resolvable repoRoot are grouped together under null, not assumed related to each other", async () => {
  const sessions = [
    makeSession({ sessionId: "x", projectDir: "/definitely/does/not/exist/agent-relay-1" }),
    makeSession({ sessionId: "y", projectDir: "/definitely/does/not/exist/agent-relay-2" }),
  ];
  const associated = await associateSessions(sessions);
  const groups = groupByProject(associated);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.repoRoot, null);
  assert.equal(groups[0]?.sessions.length, 2);
});
