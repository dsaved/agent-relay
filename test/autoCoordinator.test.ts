import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AutomaticHandoffCoordinator } from "../src/auto/coordinator.js";
import { HandoffStore } from "../src/handoff/store.js";
import type { AgentExecutionAdapter } from "../src/execution/types.js";
import type { SessionProvider } from "../src/sessions/types.js";
import type { UsageSnapshot } from "../src/usage/types.js";
import type { ProviderActivitySignal } from "../src/handoff/lock.js";
import { git, withTempRepo } from "./helpers/tempGitRepo.js";
import { withTempStoreRoot } from "./helpers/tempHandoffEnv.js";
import { FakeExecutionAdapter, fakeOutcome, fakeResult } from "./helpers/fakeExecutionAdapter.js";
import { AVAILABLE, CONFIRMED_IDLE, UNKNOWN, exhausted, setupAutoTask, usageMap } from "./helpers/autoTestEnv.js";

interface Ctx {
  repoRoot: string;
  store: HandoffStore;
}

async function withEnv(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      await run({ repoRoot, store: new HandoffStore(storeRoot) });
    });
  });
}

function coordinatorWith(
  store: HandoffStore,
  adapters: Partial<Record<SessionProvider, AgentExecutionAdapter>>,
  getUsageStatus: (provider: SessionProvider) => Promise<UsageSnapshot>,
  checkProviderActivity: () => Promise<ProviderActivitySignal> = async () => CONFIRMED_IDLE,
): AutomaticHandoffCoordinator {
  return new AutomaticHandoffCoordinator({ store, adapters, getUsageStatus, checkProviderActivity });
}

test("Claude exhausted -> Codex continues and completes", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude"); // claude is the stalled/original provider
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-1" }));
    const coordinator = coordinatorWith(ctx.store, { codex }, usageMap({ claude: exhausted(), codex: AVAILABLE }));

    const state = await coordinator.start(taskId);
    assert.equal(state.state, "completed");
    assert.equal(state.currentProvider, "codex");
    assert.equal(codex.calls.length, 1);
  });
});

test("Codex exhausted -> Claude continues and completes", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "codex");
    const claude = new FakeExecutionAdapter("claude", () => fakeResult("claude", { sessionId: "claude-1" }));
    const coordinator = coordinatorWith(ctx.store, { claude }, usageMap({ codex: exhausted(), claude: AVAILABLE }));

    const state = await coordinator.start(taskId);
    assert.equal(state.state, "completed");
    assert.equal(state.currentProvider, "claude");
  });
});

test("Both providers exhausted -> task pauses (paused_exhausted), with cooldown recorded", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const coordinator = coordinatorWith(ctx.store, {}, usageMap({ claude: exhausted(), codex: exhausted(resetsAt) }));

    const state = await coordinator.start(taskId);
    assert.equal(state.state, "paused_exhausted");
    assert.ok(state.cooldowns.codex);
    assert.equal(state.cooldowns.codex!.fromReportedReset, true);
  });
});

test("One provider's usage status is unknown: disabled by default -> pauses for approval; enabled -> proceeds within bounded attempts", async () => {
  await withEnv(async (ctx) => {
    const { taskId: taskA } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const coordinatorDisabled = coordinatorWith(ctx.store, {}, usageMap({ claude: exhausted(), codex: UNKNOWN }));
    const stateDisabled = await coordinatorDisabled.start(taskA);
    assert.equal(stateDisabled.state, "paused_approval");

    const { taskId: taskB } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-unknown-ok" }));
    const coordinatorEnabled = coordinatorWith(ctx.store, { codex }, usageMap({ claude: exhausted(), codex: UNKNOWN }));
    const stateEnabled = await coordinatorEnabled.start(taskB, { allowUnknownAvailability: true });
    assert.equal(stateEnabled.state, "completed");
    // Codex's status was "unknown" for its one selection — the bounded-attempt counter records that, since it's only reset to 0 once a provider reports a definitive answer.
    assert.equal(stateEnabled.unknownAttemptsByProvider.codex, 1);
  });
});

test("Agent crashes midway through editing -> coordinator automatically bounces to the alternative provider, which completes", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-crash-1", outcome: fakeOutcome("crashed", "simulated crash mid-edit") }));
    const claude = new FakeExecutionAdapter("claude", () => fakeResult("claude", { sessionId: "claude-recovers-1" }));
    const coordinator = coordinatorWith(ctx.store, { codex, claude }, usageMap({ claude: AVAILABLE, codex: AVAILABLE }));

    const state = await coordinator.start(taskId);
    assert.equal(state.state, "completed");
    assert.equal(state.handoffCount, 2);
    assert.equal(codex.calls.length, 1);
    assert.equal(claude.calls.length, 1);

    const finalHandoff = await ctx.store.loadHandoff(state.currentHandoffId!);
    assert.match(finalHandoff!.knownErrors.join(" "), /crashed/);
  });
});

test("Source worker still alive (external_unknown, confirmed_busy) -> handoff blocked, never forced", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex"));
    const coordinator = coordinatorWith(ctx.store, { codex }, usageMap({ claude: exhausted(), codex: AVAILABLE }), async () => ({
      status: "confirmed_busy",
      reason: "the source session is still running",
    }));

    const state = await coordinator.start(taskId);
    assert.equal(state.state, "paused_approval");
    assert.match(state.transitions.at(-1)!.reason ?? "", /confirmed_busy/);
    assert.equal(codex.calls.length, 0);
  });
});

test("External desktop activity unknown -> handoff blocked, never forced", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "codex");
    const claude = new FakeExecutionAdapter("claude", () => fakeResult("claude"));
    const coordinator = coordinatorWith(ctx.store, { claude }, usageMap({ codex: exhausted(), claude: AVAILABLE }), async () => ({
      status: "unknown",
      reason: "a Codex session exists for this workspace; liveness cannot be confirmed",
    }));

    const state = await coordinator.start(taskId);
    assert.equal(state.state, "paused_approval");
    assert.equal(claude.calls.length, 0);
  });
});

test("Destination provider becomes exhausted at selection time -> task pauses without ever calling its adapter", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex"));
    const coordinator = coordinatorWith(ctx.store, { codex }, usageMap({ claude: exhausted(), codex: exhausted() }));

    const state = await coordinator.start(taskId);
    assert.equal(state.state, "paused_exhausted");
    assert.equal(codex.calls.length, 0);
  });
});

test("Multiple consecutive handoffs: two crashes in a row still eventually complete, with accurate handoff/attempt counts", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", (_o, i) => (i === 0 ? fakeResult("codex", { outcome: fakeOutcome("crashed", "attempt 1") }) : fakeResult("codex", { sessionId: "codex-final" })));
    const claude = new FakeExecutionAdapter("claude", () => fakeResult("claude", { outcome: fakeOutcome("timed_out", "attempt 2") }));
    const coordinator = coordinatorWith(ctx.store, { codex, claude }, usageMap({ claude: AVAILABLE, codex: AVAILABLE }));

    const state = await coordinator.start(taskId, { maxHandoffs: 10, maxAttempts: 10 });
    assert.equal(state.state, "completed");
    assert.equal(state.handoffCount, 3); // claude(start)->codex(crash)->claude(timeout)->codex(completes)
    assert.equal(codex.calls.length, 2);
    assert.equal(claude.calls.length, 1);
  });
});

test("Maximum handoff limit stops an infinite bounce as 'failed', not an endless loop", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { outcome: fakeOutcome("crashed", "keeps crashing") }));
    const claude = new FakeExecutionAdapter("claude", () => fakeResult("claude", { outcome: fakeOutcome("crashed", "keeps crashing") }));
    const coordinator = coordinatorWith(ctx.store, { codex, claude }, usageMap({ claude: AVAILABLE, codex: AVAILABLE }));

    const state = await coordinator.start(taskId, { maxHandoffs: 2, maxAttempts: 10 });
    assert.equal(state.state, "failed");
    assert.match(state.failureReason ?? "", /maximum of 2 handoff/);
    assert.ok(state.handoffCount <= 2);
  });
});

test("Validation failure after a successful agent turn pauses for approval, not an automatic retry", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-val-1" }));
    const coordinator = coordinatorWith(ctx.store, { codex }, usageMap({ claude: exhausted(), codex: AVAILABLE }));

    const state = await coordinator.start(taskId, { validationCommands: [`"${process.execPath}" -e "process.exit(1)"`] });
    assert.equal(state.state, "paused_approval");
    assert.equal(codex.calls.length, 1); // did not retry
  });
});

test("No duplicate worker execution: starting an already-completed task again is a no-op", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-once" }));
    const coordinator = coordinatorWith(ctx.store, { codex }, usageMap({ claude: exhausted(), codex: AVAILABLE }));

    const first = await coordinator.start(taskId);
    assert.equal(first.state, "completed");
    const second = await coordinator.start(taskId);
    assert.equal(second.state, "completed");
    assert.equal(codex.calls.length, 1, "the adapter must not be invoked again for an already-completed task");
    assert.deepEqual(second, first);
  });
});

test("No automatic use of --force-lock: a busy/unknown activity signal is always refused automatically, with forceLockOverride never set", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex"));
    const coordinator = coordinatorWith(ctx.store, { codex }, usageMap({ claude: exhausted(), codex: AVAILABLE }), async () => ({ status: "confirmed_busy", reason: "live" }));

    const state = await coordinator.start(taskId);
    assert.equal(state.state, "paused_approval");
    assert.equal(codex.calls.length, 0, "a force-locked takeover would have let the adapter run; it must not have");
  });
});

test("Preservation of existing work: a dirty working tree is unchanged across an automatic crash-and-bounce cycle", async () => {
  await withEnv(async (ctx) => {
    await writeFile(join(ctx.repoRoot, "scratch.txt"), "untouched\n");
    const before = git(["status", "--porcelain=v1"], ctx.repoRoot);

    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { outcome: fakeOutcome("crashed", "simulated") }));
    const claude = new FakeExecutionAdapter("claude", () => fakeResult("claude", { sessionId: "claude-preserves" }));
    const coordinator = coordinatorWith(ctx.store, { codex, claude }, usageMap({ claude: AVAILABLE, codex: AVAILABLE }));

    const state = await coordinator.start(taskId);
    assert.equal(state.state, "completed");

    const after = git(["status", "--porcelain=v1"], ctx.repoRoot);
    assert.equal(after, before);
    assert.equal(await readFile(join(ctx.repoRoot, "scratch.txt"), "utf8"), "untouched\n");

    const log = git(["log", "--oneline"], ctx.repoRoot).trim().split("\n");
    assert.equal(log.length, 1, "the coordinator must never create a git commit on its own");
  });
});
