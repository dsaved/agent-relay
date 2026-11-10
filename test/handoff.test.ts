import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareHandoffSnapshot } from "../src/sessions/handoff.js";
import type { SessionAssociation } from "../src/sessions/types.js";
import { git, withTempRepo } from "./helpers/tempGitRepo.js";

function makeAssociation(overrides: Partial<SessionAssociation>): SessionAssociation {
  return {
    provider: "claude",
    sessionId: "s-1",
    projectDir: null,
    status: "idle",
    lastActivity: null,
    discoverySource: "test",
    pid: null,
    title: "Implement the thing",
    providerGitInfo: null,
    repoRoot: null,
    worktreePath: null,
    workspaceAccessible: null,
    ...overrides,
  };
}

test("prepareHandoffSnapshot: clean repo -> no files, real branch/HEAD, no judgment fields", async () => {
  await withTempRepo(async (repoRoot) => {
    git(["checkout", "-b", "main"], repoRoot);
    const snapshot = await prepareHandoffSnapshot(makeAssociation({ repoRoot, workspaceAccessible: true }));

    assert.equal(snapshot.repoRoot, repoRoot);
    assert.equal(snapshot.worktreePath, null);
    assert.equal(snapshot.git?.branch, "main");
    assert.match(snapshot.git?.headSha ?? "", /^[0-9a-f]{40}$/);
    assert.deepEqual(snapshot.git?.files, []);
    assert.equal(snapshot.availableTaskDescription, "Implement the thing");
    assert.equal(snapshot.validationResults, null);
    assert.ok(!("complete" in snapshot) && !("isComplete" in snapshot) && !("done" in snapshot));
  });
});

test("prepareHandoffSnapshot: preserves modified + untracked files verbatim, with their porcelain codes", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeFile(join(repoRoot, "README.md"), "modified content\n");
    await writeFile(join(repoRoot, "new-file.txt"), "scratch\n");

    const snapshot = await prepareHandoffSnapshot(makeAssociation({ repoRoot, workspaceAccessible: true }));

    const byPath = new Map(snapshot.git?.files.map((f) => [f.path, f.code]));
    assert.equal(byPath.get("README.md"), " M");
    assert.equal(byPath.get("new-file.txt"), "??");
    assert.equal(snapshot.git?.files.length, 2);
  });
});

test("prepareHandoffSnapshot: a session with no resolvable repo -> git is null, no throw", async () => {
  const snapshot = await prepareHandoffSnapshot(makeAssociation({ repoRoot: null, worktreePath: null }));
  assert.equal(snapshot.git, null);
  assert.equal(snapshot.repoRoot, null);
});

test("prepareHandoffSnapshot: codex session reports provider progress info; claude session does not fabricate any", async () => {
  await withTempRepo(async (repoRoot) => {
    const codexSnap = await prepareHandoffSnapshot(
      makeAssociation({ provider: "codex", repoRoot, workspaceAccessible: true, status: "active", providerGitInfo: { branch: "main", sha: "abc", originUrl: null } }),
    );
    assert.deepEqual(codexSnap.availableProgressInformation, {
      lastKnownStatus: "active",
      providerGitInfo: { branch: "main", sha: "abc", originUrl: null },
    });

    const claudeSnap = await prepareHandoffSnapshot(makeAssociation({ provider: "claude", repoRoot, workspaceAccessible: true }));
    assert.equal(claudeSnap.availableProgressInformation, null);
  });
});
