import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceLockManager, lockKeyFor } from "../src/handoff/lock.js";
import { HandoffStore } from "../src/handoff/store.js";
import { withTempRepo } from "./helpers/tempGitRepo.js";
import { withTempStoreRoot } from "./helpers/tempHandoffEnv.js";

/** A pid guaranteed not to be running: spawn a trivial process and wait for it to exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid as number;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

/** A pid guaranteed to be running for the lifetime of the test, unrelated to this process. */
function spawnLongLived() {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
}

test("symlink workspace alias: locking through a symlink and through its real path collide on the same lock key", async () => {
  await withTempRepo(async (repoRoot) => {
    const aliasPath = join(repoRoot, "..", "agent-relay-alias-" + Date.now());
    await symlink(repoRoot, aliasPath);
    try {
      const realKey = await lockKeyFor(repoRoot);
      const aliasKey = await lockKeyFor(aliasPath);
      assert.equal(aliasKey, realKey);

      const lockManager = new WorkspaceLockManager(new HandoffStore(join(repoRoot, "..", "agent-relay-alias-store-" + Date.now())));
      const viaReal = await lockManager.acquire(repoRoot, "handoff-via-real");
      assert.equal(viaReal.acquired, true);

      const viaAlias = await lockManager.acquire(aliasPath, "handoff-via-alias");
      assert.equal(viaAlias.acquired, false, "the symlinked path must be recognized as the SAME workspace, already held");
    } finally {
      await import("node:fs/promises").then((fs) => fs.rm(aliasPath, { force: true }));
    }
  });
});

test("two controllers racing for a never-before-held workspace: exactly one wins, atomically", async () => {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      const lockManager = new WorkspaceLockManager(new HandoffStore(storeRoot));
      const [a, b] = await Promise.all([lockManager.acquire(repoRoot, "controller-a"), lockManager.acquire(repoRoot, "controller-b")]);

      const winners = [a, b].filter((r) => r.acquired);
      assert.equal(winners.length, 1, "exactly one of the two simultaneous acquires must succeed");
    });
  });
});

test("a lock whose recorded pid now belongs to a different, unrelated LIVE process is still refused — reuse is never assumed to mean safe", async () => {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      const store = new HandoffStore(storeRoot);
      const unrelatedLiveProcess = spawnLongLived();
      try {
        // Simulate: the original holder crashed, and (hypothetically) the OS
        // reassigned its pid number to this unrelated, currently-running process.
        await store.writeLock({
          lockKey: await lockKeyFor(repoRoot),
          workspacePath: repoRoot,
          holderPid: unrelatedLiveProcess.pid as number,
          holderHandoffId: "long-gone-handoff",
          holderToken: "stale-token",
          acquiredAt: Date.now() - 999_999,
        });

        const lockManager = new WorkspaceLockManager(store);
        const result = await lockManager.acquire(repoRoot, "new-handoff");
        assert.equal(result.acquired, false, "a live pid is never treated as safe to steal, whoever it actually belongs to");
      } finally {
        unrelatedLiveProcess.kill("SIGKILL");
      }
    });
  });
});

test("dead pid is still correctly recovered (not confused with the reuse-safety test above)", async () => {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      const store = new HandoffStore(storeRoot);
      await store.writeLock({
        lockKey: await lockKeyFor(repoRoot),
        workspacePath: repoRoot,
        holderPid: await deadPid(),
        holderHandoffId: "crashed-handoff",
        holderToken: "dead-token",
        acquiredAt: Date.now() - 999_999,
      });

      const result = await new WorkspaceLockManager(store).acquire(repoRoot, "new-handoff");
      assert.equal(result.acquired, true);
      if (result.acquired) assert.equal(result.recoveredFromCrash, true);
    });
  });
});

test("'unknown' activity status refuses takeover by default, exactly like 'confirmed_busy' — only forceOverride passes either", async () => {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      const lockManager = new WorkspaceLockManager(new HandoffStore(storeRoot));
      const unknownCheck = async () => ({ status: "unknown" as const, reason: "cannot confirm" });

      const refused = await lockManager.acquire(repoRoot, "h1", { checkProviderActivity: unknownCheck });
      assert.equal(refused.acquired, false);

      const forced = await lockManager.acquire(repoRoot, "h1", { checkProviderActivity: unknownCheck, forceOverride: true });
      assert.equal(forced.acquired, true);
      if (forced.acquired) assert.equal(forced.overrideUsed, true);
    });
  });
});
