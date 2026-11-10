import { test } from "node:test";
import assert from "node:assert/strict";
import { AutomaticHandoffCoordinator } from "../src/auto/coordinator.js";
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

/** A fake adapter that blocks on `options.signal`, so a test can prove a pause/stop actually interrupts an in-flight execution rather than merely refusing to start one. */
function blockingUntilAbortedAdapter(provider: "claude" | "codex"): FakeExecutionAdapter {
  return new FakeExecutionAdapter(provider, (options: ExecutionRunOptions) => {
    return new Promise((resolve) => {
      const finish = () => resolve(fakeResult(provider, { outcome: { kind: "cancelled", detail: typeof options.signal?.reason === "string" ? options.signal.reason : "cancelled", cooldownResetsAt: null } }));
      if (options.signal?.aborted) return finish();
      options.signal?.addEventListener("abort", finish);
    });
  });
}

test("aborting with reason 'stop' while an agent is executing ends the task 'stopped', not 'failed'", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = blockingUntilAbortedAdapter("codex");
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, adapters: { codex }, getUsageStatus: usageMap({ claude: AVAILABLE, codex: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_IDLE });

    const controller = new AbortController();
    const statePromise = coordinator.start(taskId, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort("stop");

    const state = await statePromise;
    assert.equal(state.state, "stopped");
    assert.equal(state.lastOutcome?.kind, "cancelled");
  });
});

test("aborting with reason 'pause' while an agent is executing ends the task 'paused_approval', resumable afterward", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = blockingUntilAbortedAdapter("codex");
    const claude = new FakeExecutionAdapter("claude", () => fakeResult("claude", { sessionId: "claude-after-pause" }));
    const coordinator = new AutomaticHandoffCoordinator({
      store: ctx.store,
      adapters: { codex, claude },
      getUsageStatus: usageMap({ claude: AVAILABLE, codex: AVAILABLE }),
      checkProviderActivity: async () => CONFIRMED_IDLE,
    });

    const controller = new AbortController();
    const statePromise = coordinator.start(taskId, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort("pause");
    const paused = await statePromise;
    assert.equal(paused.state, "paused_approval");
    assert.equal(paused.lastOutcome?.kind, "cancelled");

    // Resuming a "paused_approval" task re-checks ownership and selects a
    // provider fresh, same as resuming any other paused_approval task —
    // pausing mid-execution isn't special-cased into resuming the exact
    // same destination session, only into reaching this distinct state.
    const resumed = await coordinator.resume(taskId);
    assert.equal(resumed.state, "completed");
    assert.equal(claude.calls.length, 1);
  });
});

test("a plain stop() on a paused task (nothing in flight in this process) still reports 'failed', unchanged from Phase 3A", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, getUsageStatus: usageMap({ claude: { classification: "exhausted", observedAt: Date.now(), primary: null, secondary: null }, codex: { classification: "exhausted", observedAt: Date.now(), primary: { usedPercent: 100, resetsAt }, secondary: null } }) });
    const pausedExhausted = await coordinator.start(taskId);
    assert.equal(pausedExhausted.state, "paused_exhausted");

    const state = await coordinator.stop(taskId);
    assert.equal(state.state, "failed");
    assert.equal(state.failureReason, "stopped by user");
  });
});
