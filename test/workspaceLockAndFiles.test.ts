import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHandoffRecord } from "../src/handoff/prepare.js";
import { HandoffStore } from "../src/handoff/store.js";
import { HandoffEngine } from "../src/handoff/engine.js";
import { WorkspaceLockManager, lockKeyFor } from "../src/handoff/lock.js";
import type { AgentExecutionAdapter } from "../src/execution/types.js";
import type { UsageSnapshot } from "../src/usage/types.js";
import { git, withTempRepo } from "./helpers/tempGitRepo.js";
import { makeSessionAssociation, withTempStoreRoot } from "./helpers/tempHandoffEnv.js";
import { FakeExecutionAdapter, fakeResult } from "./helpers/fakeExecutionAdapter.js";

const AVAILABLE: UsageSnapshot = { classification: "available", observedAt: Date.now(), primary: null, secondary: null };

function engineWith(store: HandoffStore, dest: AgentExecutionAdapter) {
  return new HandoffEngine({
    store,
    adapters: { [dest.provider]: dest },
    getUsageStatus: async () => AVAILABLE,
    checkProviderActivity: async () => ({ status: "confirmed_idle", reason: "no activity signal configured for this test" }),
  });
}

/** A pid guaranteed not to be running: spawn a trivial process and wait for it to exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid as number;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

test("preserves modified/untracked files exactly: executeHandoff never commits, resets, or stashes", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeFile(join(repoRoot, "README.md"), "edited by someone\n");
    await writeFile(join(repoRoot, "scratch.txt"), "untracked\n");
    const before = git(["status", "--porcelain=v1"], repoRoot);

    await withTempStoreRoot(async (storeRoot) => {
      const store = new HandoffStore(storeRoot);
      const session = makeSessionAssociation({ provider: "codex", repoRoot, workspaceAccessible: true });
      const { task, handoff } = await createHandoffRecord(session);
      await store.saveTask(task);
      await store.saveHandoff(handoff);

      const dest = new FakeExecutionAdapter("claude", () => fakeResult("claude", { sessionId: "claude-files-1" }));
      const engine = engineWith(store, dest);
      const result = await engine.executeHandoff(handoff.handoffId, { to: "claude" });

      assert.equal(result.handoff.status, "completed");
      assert.deepEqual(result.handoff.files.map((f) => f.path).sort(), ["README.md", "scratch.txt"]);
    });

    const after = git(["status", "--porcelain=v1"], repoRoot);
    assert.equal(after, before);
  });
});

test("multiple worktrees under one repo get independent lock keys — locking one never blocks the other", async () => {
  await withTempRepo(async (repoRoot) => {
    const worktreeA = join(repoRoot, "..", "agent-relay-wt-a-" + Date.now());
    const worktreeB = join(repoRoot, "..", "agent-relay-wt-b-" + Date.now());
    git(["worktree", "add", "-b", "wt-a", worktreeA], repoRoot);
    git(["worktree", "add", "-b", "wt-b", worktreeB], repoRoot);
    try {
      const lockManager = new WorkspaceLockManager(new HandoffStore(join(repoRoot, "..", "agent-relay-lock-store-" + Date.now())));
      const a = await lockManager.acquire(worktreeA, "handoff-a");
      const b = await lockManager.acquire(worktreeB, "handoff-b");
      assert.equal(a.acquired, true);
      assert.equal(b.acquired, true);
    } finally {
      git(["worktree", "remove", "--force", worktreeA], repoRoot);
      git(["worktree", "remove", "--force", worktreeB], repoRoot);
    }
  });
});

test("concurrent workspace ownership: a live Relay-held lock refuses takeover unless explicitly overridden", async () => {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      const store = new HandoffStore(storeRoot);
      const session = makeSessionAssociation({ provider: "codex", repoRoot, workspaceAccessible: true });
      const { task, handoff } = await createHandoffRecord(session);
      await store.saveTask(task);
      await store.saveHandoff(handoff);

      // Simulate another live Relay worker already holding the lock (our own pid IS alive, just a different handoff id).
      await store.writeLock({ lockKey: await lockKeyFor(repoRoot), workspacePath: repoRoot, holderPid: process.pid, holderHandoffId: "other-handoff", holderToken: "other-token", acquiredAt: Date.now() });

      const dest = new FakeExecutionAdapter("claude", () => fakeResult("claude"));
      const engine = engineWith(store, dest);

      const blocked = await engine.executeHandoff(handoff.handoffId, { to: "claude" });
      assert.equal(blocked.handoff.status, "blocked");
      assert.match(blocked.blockedReason ?? "", /live Relay worker/);
      assert.equal(dest.calls.length, 0);

      const overridden = await engine.executeHandoff(handoff.handoffId, { to: "claude", forceLockOverride: true });
      assert.equal(overridden.handoff.status, "completed");
      assert.equal(overridden.attempt.lockOverrideUsed, true);
    });
  });
});

test("stale lock (holder process no longer running) is recovered automatically, no override needed", async () => {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      const store = new HandoffStore(storeRoot);
      const pid = await deadPid();
      await store.writeLock({ lockKey: await lockKeyFor(repoRoot), workspacePath: repoRoot, holderPid: pid, holderHandoffId: "crashed-handoff", holderToken: "dead-token", acquiredAt: Date.now() - 999_999 });

      const lockManager = new WorkspaceLockManager(store);
      const result = await lockManager.acquire(repoRoot, "new-handoff");

      assert.equal(result.acquired, true);
      if (result.acquired) assert.equal(result.recoveredFromCrash, true);
    });
  });
});
