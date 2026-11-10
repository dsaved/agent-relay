import { test } from "node:test";
import assert from "node:assert/strict";
import { AutomaticHandoffCoordinator } from "../src/auto/coordinator.js";
import { TaskScheduler } from "../src/daemon/scheduler.js";
import { HandoffStore } from "../src/handoff/store.js";
import type { ExecutionRunOptions } from "../src/execution/types.js";
import { withTempRepo } from "./helpers/tempGitRepo.js";
import { withTempStoreRoot } from "./helpers/tempHandoffEnv.js";
import { FakeExecutionAdapter, fakeResult } from "./helpers/fakeExecutionAdapter.js";
import { AVAILABLE, CONFIRMED_IDLE, setupAutoTask, usageMap } from "./helpers/autoTestEnv.js";

async function withEnv(run: (ctx: { repoRoot: string; store: HandoffStore }) => Promise<void>): Promise<void> {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      await run({ repoRoot, store: new HandoffStore(storeRoot) });
    });
  });
}

function blockingUntilAbortedAdapter(provider: "claude" | "codex"): FakeExecutionAdapter {
  return new FakeExecutionAdapter(provider, (options: ExecutionRunOptions) => {
    return new Promise((resolve) => {
      const finish = () => resolve(fakeResult(provider, { outcome: { kind: "cancelled", detail: typeof options.signal?.reason === "string" ? options.signal.reason : "cancelled", cooldownResetsAt: null } }));
      if (options.signal?.aborted) return finish();
      options.signal?.addEventListener("abort", finish);
    });
  });
}

test("submit() is non-blocking: it returns while the task is still genuinely running in the background", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = blockingUntilAbortedAdapter("codex");
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, adapters: { codex }, getUsageStatus: usageMap({ claude: AVAILABLE, codex: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_IDLE });
    const scheduler = new TaskScheduler(coordinator, ctx.store, 4);

    const submitted = await scheduler.submit(taskId);
    assert.equal(submitted.running, true);
    assert.notEqual(submitted.state.state, "completed");
    assert.ok(scheduler.isRunning(taskId));

    await scheduler.requestStop(taskId);
    assert.equal(scheduler.isRunning(taskId), false);
  });
});

test("submit() on an already-in-flight task returns the current recorded state without starting a duplicate worker", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = blockingUntilAbortedAdapter("codex");
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, adapters: { codex }, getUsageStatus: usageMap({ claude: AVAILABLE, codex: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_IDLE });
    const scheduler = new TaskScheduler(coordinator, ctx.store, 4);

    await scheduler.submit(taskId);
    await scheduler.submit(taskId); // must not start a second worker

    // The in-flight run reaches the actual adapter call asynchronously
    // (several awaited steps after submit() itself returns) — wait for
    // that to happen, then confirm the second submit() never added a
    // second one.
    for (let i = 0; i < 50 && codex.calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(codex.calls.length, 1, "no duplicate execution for an already-running task");

    await scheduler.requestStop(taskId);
  });
});

test("requestPause/requestStop actually interrupt a genuinely in-flight run (not just a state mutation)", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = blockingUntilAbortedAdapter("codex");
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, adapters: { codex }, getUsageStatus: usageMap({ claude: AVAILABLE, codex: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_IDLE });
    const scheduler = new TaskScheduler(coordinator, ctx.store, 4);

    await scheduler.submit(taskId);
    const final = await scheduler.requestStop(taskId);
    assert.equal(final.state, "stopped");
    assert.equal(scheduler.isRunning(taskId), false);
  });
});

test("requestPause/requestStop fall through to the coordinator's direct store mutation when nothing is tracked for that task id", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-quick" }));
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, adapters: { codex }, getUsageStatus: usageMap({ claude: AVAILABLE, codex: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_IDLE });
    const scheduler = new TaskScheduler(coordinator, ctx.store, 4);

    const submitted = await scheduler.submit(taskId);
    // Wait for the quick, non-blocking fake run to settle and leave the in-flight map on its own.
    while (scheduler.isRunning(taskId)) await new Promise((resolve) => setTimeout(resolve, 5));
    void submitted;

    // Nothing tracked now — this must route straight to coordinator.pause(), not throw.
    const paused = await scheduler.requestPause(taskId);
    assert.equal(paused.state, "completed"); // already terminal — pause() on a terminal task is a no-op, unchanged from Phase 3A
  });
});

test("the scheduler refuses a new submission past the configured maxConcurrentTasks", async () => {
  await withEnv(async (ctx) => {
    const { taskId: taskA } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const { taskId: taskB } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = blockingUntilAbortedAdapter("codex");
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, adapters: { codex }, getUsageStatus: usageMap({ claude: AVAILABLE, codex: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_IDLE });
    const scheduler = new TaskScheduler(coordinator, ctx.store, 1);

    await scheduler.submit(taskA);
    await assert.rejects(() => scheduler.submit(taskB), /maximum of 1 concurrent/);
    await scheduler.requestStop(taskA);
  });
});
