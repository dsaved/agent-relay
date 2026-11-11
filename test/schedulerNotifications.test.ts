import { test } from "node:test";
import assert from "node:assert/strict";
import { AutomaticHandoffCoordinator } from "../src/auto/coordinator.js";
import { TaskScheduler } from "../src/daemon/scheduler.js";
import { HandoffStore } from "../src/handoff/store.js";
import type { SessionProvider } from "../src/sessions/types.js";
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

async function waitUntilSettled(scheduler: TaskScheduler, taskId: string): Promise<void> {
  while (scheduler.isRunning(taskId)) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("scheduler: a fresh pause (pendingProviderChoice set) fires notifyChoice with the candidates; no pick made -> nothing else happens", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, getUsageStatus: usageMap({}), checkProviderActivity: async () => CONFIRMED_IDLE });

    const choiceCalls: { candidates: SessionProvider[]; current: SessionProvider; taskId: string }[] = [];
    const notifyChoice = async (candidates: SessionProvider[], current: SessionProvider, tid: string) => {
      choiceCalls.push({ candidates, current, taskId: tid });
      return null; // dismissed — nothing picked
    };
    const notifyReady = async () => {};
    const scheduler = new TaskScheduler(coordinator, ctx.store, 4, undefined, notifyChoice, notifyReady);

    await scheduler.submit(taskId);
    await waitUntilSettled(scheduler, taskId);
    // handleSettled's own notification call is detached/fire-and-forget — give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(choiceCalls.length, 1);
    assert.deepEqual(choiceCalls[0], { candidates: ["codex"], current: "claude", taskId });
  });
});

test("scheduler: a notifyChoice pick auto-resumes the task with that pin, no extra CLI round trip needed", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-auto-picked" }));
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, adapters: { codex }, getUsageStatus: usageMap({ codex: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_IDLE });

    const notifyChoice = async () => "codex" as SessionProvider;
    const readyCalls: { handoffId: string; provider: SessionProvider }[] = [];
    const notifyReady = async (handoffId: string, provider: SessionProvider) => {
      readyCalls.push({ handoffId, provider });
    };
    const scheduler = new TaskScheduler(coordinator, ctx.store, 4, undefined, notifyChoice, notifyReady);

    await scheduler.submit(taskId);
    // Give the auto-resume (triggered from inside handleSettled) time to run and settle.
    for (let i = 0; i < 50 && codex.calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await waitUntilSettled(scheduler, taskId);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const final = await ctx.store.loadAutoTask(taskId);
    assert.equal(final?.state, "completed");
    assert.equal(codex.calls.length, 1);
    assert.equal(readyCalls.length, 1);
    assert.equal(readyCalls[0]!.provider, "codex");
  });
});

test("scheduler: a notification function that throws never blocks inFlight cleanup or the coordinator's own result", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, getUsageStatus: usageMap({}), checkProviderActivity: async () => CONFIRMED_IDLE });

    const notifyChoice = async (): Promise<SessionProvider | null> => {
      throw new Error("terminal-notifier blew up");
    };
    const notifyReady = async () => {};
    const scheduler = new TaskScheduler(coordinator, ctx.store, 4, undefined, notifyChoice, notifyReady);

    const submitted = await scheduler.submit(taskId);
    assert.equal(submitted.running, true);
    await waitUntilSettled(scheduler, taskId);
    assert.equal(scheduler.isRunning(taskId), false);
  });
});
