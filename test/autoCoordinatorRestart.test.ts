import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { AutomaticHandoffCoordinator } from "../src/auto/coordinator.js";
import { HandoffStore } from "../src/handoff/store.js";
import { lockKeyFor } from "../src/handoff/lock.js";
import type { AutoTaskState } from "../src/auto/types.js";
import { withTempRepo } from "./helpers/tempGitRepo.js";
import { withTempStoreRoot } from "./helpers/tempHandoffEnv.js";
import { FakeExecutionAdapter, fakeResult } from "./helpers/fakeExecutionAdapter.js";
import { AVAILABLE, setupAutoTask, usageMap } from "./helpers/autoTestEnv.js";

/** A pid guaranteed not to be running: spawn a trivial process and wait for it to exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid as number;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

test("coordinator restart during a handoff: a stale lock left by a crashed prior process is recovered, and the leg runs exactly once", async () => {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      const store = new HandoffStore(storeRoot);
      const { taskId, handoffId } = await setupAutoTask(store, repoRoot, "claude");

      // Simulate a coordinator process that got all the way to "handing_off"
      // (selected codex, about to execute) and then crashed before finishing
      // — leaving both the AutoTaskState and the workspace lock behind.
      const now = Date.now();
      const crashedState: AutoTaskState = {
        taskId,
        state: "handing_off",
        currentProvider: "claude",
        currentHandoffId: handoffId,
        attemptCount: 0,
        handoffCount: 0,
        startedAt: now,
        updatedAt: now,
        limits: { maxHandoffs: 6, maxAttempts: 6, maxRuntimeMs: 3600_000 },
        unknownAvailabilityPolicy: { allow: false, maxAttempts: 2, cooldownMs: 60_000 },
        unknownAttemptsByProvider: {},
        cooldowns: {},
        validationCommands: [],
        pinnedProvider: null,
        enabledProviders: ["codex", "claude"],
        pendingDestination: "codex",
        failureReason: null,
        lastOutcome: null,
        lastHandoffStatus: null,
        transitions: [{ at: now, attemptId: "crashed-attempt", from: "selecting_provider", to: "handing_off", provider: "codex", reason: "codex usage is available" }],
      };
      await store.saveAutoTask(crashedState);
      await store.writeLock({ lockKey: await lockKeyFor(repoRoot), workspacePath: repoRoot, holderPid: await deadPid(), holderHandoffId: handoffId, holderToken: "crashed-token", acquiredAt: now - 999_999 });

      // "Restart": a brand-new coordinator instance, exactly as a fresh process would create.
      const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-after-restart" }));
      const coordinator = new AutomaticHandoffCoordinator({
        store,
        adapters: { codex },
        getUsageStatus: usageMap({ claude: AVAILABLE, codex: AVAILABLE }),
        checkProviderActivity: async () => ({ status: "confirmed_idle", reason: "no activity signal configured for this test" }),
      });

      const state = await coordinator.start(taskId);

      assert.equal(state.state, "completed");
      assert.equal(codex.calls.length, 1, "the leg must run exactly once after restart, not be duplicated");

      const finalHandoff = await store.loadHandoff(state.currentHandoffId!);
      const lastAttempt = finalHandoff!.attempts.at(-1)!;
      assert.equal(lastAttempt.ownershipVerification.lockRecoveredFromCrash, true, "the stale lock from the crashed process must have been recovered, not refused");
    });
  });
});
