import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AutomaticHandoffCoordinator } from "../src/auto/coordinator.js";
import { TaskScheduler } from "../src/daemon/scheduler.js";
import { runCrashRecovery } from "../src/daemon/recovery.js";
import { HandoffStore } from "../src/handoff/store.js";
import { WorkspaceLockManager, lockKeyFor } from "../src/handoff/lock.js";
import { withTempRepo } from "./helpers/tempGitRepo.js";
import { withTempStoreRoot } from "./helpers/tempHandoffEnv.js";
import { FakeExecutionAdapter, fakeResult } from "./helpers/fakeExecutionAdapter.js";
import { AVAILABLE, CONFIRMED_IDLE, setupAutoTask, usageMap } from "./helpers/autoTestEnv.js";

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid as number;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

async function withEnv(run: (ctx: { repoRoot: string; stateDir: string; store: HandoffStore; lockManager: WorkspaceLockManager }) => Promise<void>): Promise<void> {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      const store = new HandoffStore(storeRoot);
      await run({ repoRoot, stateDir: storeRoot, store, lockManager: new WorkspaceLockManager(store) });
    });
  });
}

test("recovery resumes a task left mid-flight with no recorded workspace lock at all", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-recovered" }));
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, adapters: { codex }, getUsageStatus: usageMap({ claude: AVAILABLE, codex: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_IDLE });
    const scheduler = new TaskScheduler(coordinator, ctx.store, 4);

    // Simulate "the daemon died before this task made any progress" —
    // persist the queued state without ever running the loop.
    await coordinator.prepareStart(taskId);

    const decisions = await runCrashRecovery(ctx.store, scheduler, ctx.lockManager, undefined);
    assert.equal(decisions.find((d) => d.taskId === taskId)?.decision, "resumed");

    // Phase 9: `submit()`'s recovery-driven run only ever reaches the
    // first pause-and-ask — it never auto-picks a destination.
    while (scheduler.isRunning(taskId)) await new Promise((resolve) => setTimeout(resolve, 5));
    const paused = await ctx.store.loadAutoTask(taskId);
    assert.equal(paused?.state, "paused_approval");
    assert.deepEqual(paused?.pendingProviderChoice, ["codex"]);

    await scheduler.resume(taskId, undefined, "codex");
    while (scheduler.isRunning(taskId)) await new Promise((resolve) => setTimeout(resolve, 5));
    const final = await ctx.store.loadAutoTask(taskId);
    assert.equal(final?.state, "completed");
    assert.equal(codex.calls.length, 1, "exactly one execution — no duplicate worker");
  });
});

test("recovery resumes a task whose recorded lock holder is confirmed dead — never assumes an old PID is still the original worker", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-recovered-2" }));
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, adapters: { codex }, getUsageStatus: usageMap({ claude: AVAILABLE, codex: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_IDLE });
    const scheduler = new TaskScheduler(coordinator, ctx.store, 4);

    await coordinator.prepareStart(taskId);
    await ctx.store.writeLock({ lockKey: await lockKeyFor(ctx.repoRoot), workspacePath: ctx.repoRoot, holderPid: await deadPid(), holderHandoffId: "stale", holderToken: "t", acquiredAt: Date.now() });

    const decisions = await runCrashRecovery(ctx.store, scheduler, ctx.lockManager, undefined);
    const decision = decisions.find((d) => d.taskId === taskId);
    assert.equal(decision?.decision, "resumed");
    assert.match(decision?.reason ?? "", /confirmed dead/);

    while (scheduler.isRunning(taskId)) await new Promise((resolve) => setTimeout(resolve, 5));
    await scheduler.resume(taskId, undefined, "codex");
    while (scheduler.isRunning(taskId)) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(codex.calls.length, 1);
  });
});

test("recovery leaves a task alone when its workspace lock is held by a genuinely live process — refuses to resume under uncertainty", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex"));
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, adapters: { codex }, getUsageStatus: usageMap({ claude: AVAILABLE, codex: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_IDLE });
    const scheduler = new TaskScheduler(coordinator, ctx.store, 4);

    await coordinator.prepareStart(taskId);
    // This test process's own pid is, trivially, genuinely alive.
    await ctx.store.writeLock({ lockKey: await lockKeyFor(ctx.repoRoot), workspacePath: ctx.repoRoot, holderPid: process.pid, holderHandoffId: "someone-else", holderToken: "t", acquiredAt: Date.now() });

    const decisions = await runCrashRecovery(ctx.store, scheduler, ctx.lockManager, undefined);
    const decision = decisions.find((d) => d.taskId === taskId);
    assert.equal(decision?.decision, "left_alone");
    assert.match(decision?.reason ?? "", /live process/);
    assert.equal(scheduler.isRunning(taskId), false);
    assert.equal(codex.calls.length, 0, "never resumed under uncertainty");
  });
});

test("recovery skips a corrupted task-state file without crashing startup, and still processes the other tasks", async () => {
  await withEnv(async (ctx) => {
    const { taskId: goodTaskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-good" }));
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, adapters: { codex }, getUsageStatus: usageMap({ claude: AVAILABLE, codex: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_IDLE });
    const scheduler = new TaskScheduler(coordinator, ctx.store, 4);
    await coordinator.prepareStart(goodTaskId);

    // Hand-corrupt a second task-state file directly on disk.
    const autoTasksDir = join(ctx.stateDir, "autotasks");
    await mkdir(autoTasksDir, { recursive: true });
    await writeFile(join(autoTasksDir, "corrupted-task.json"), "{not valid json");

    const decisions = await runCrashRecovery(ctx.store, scheduler, ctx.lockManager, undefined);
    assert.equal(decisions.find((d) => d.taskId === "corrupted-task")?.decision, "skipped_corrupted");
    assert.equal(decisions.find((d) => d.taskId === goodTaskId)?.decision, "resumed");

    while (scheduler.isRunning(goodTaskId)) await new Promise((resolve) => setTimeout(resolve, 5));
    await scheduler.resume(goodTaskId, undefined, "codex");
    while (scheduler.isRunning(goodTaskId)) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(codex.calls.length, 1);
  });
});

test("already-settled tasks are left alone, never re-executed, by recovery", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-once-more" }));
    const coordinator = new AutomaticHandoffCoordinator({ store: ctx.store, adapters: { codex }, getUsageStatus: usageMap({ claude: AVAILABLE, codex: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_IDLE });
    const scheduler = new TaskScheduler(coordinator, ctx.store, 4);
    const paused = await coordinator.start(taskId);
    assert.deepEqual(paused.pendingProviderChoice, ["codex"]);
    const completed = await coordinator.resume(taskId, { pin: "codex" }); // runs to completion, settles
    assert.equal(completed.state, "completed");

    const decisions = await runCrashRecovery(ctx.store, scheduler, ctx.lockManager, undefined);
    assert.equal(decisions.find((d) => d.taskId === taskId)?.decision, "left_alone");
    assert.equal(codex.calls.length, 1, "no duplicate execution of an already-completed task");
  });
});
