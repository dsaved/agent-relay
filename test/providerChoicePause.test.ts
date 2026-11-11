import { test } from "node:test";
import assert from "node:assert/strict";
import { AutomaticHandoffCoordinator } from "../src/auto/coordinator.js";
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

// Phase 9's core new behavior, isolated from any particular scenario in
// autoCoordinator.test.ts: with 3+ enabled providers, the pause offers
// every enabled alternative (not just the first one availability would
// have picked); a standing `auto start --pin` never pauses at all; a
// one-time `resume({ pin })` is consumed after exactly one selection.

test("3+ enabled providers: the pause offers every enabled alternative, in enabledProviders' own order", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const coordinator = new AutomaticHandoffCoordinator({
      store: ctx.store,
      getUsageStatus: usageMap({}),
      checkProviderActivity: async () => CONFIRMED_IDLE,
    });

    const paused = await coordinator.start(taskId, { enabledProviders: ["codex", "claude", "copilot"] });
    assert.equal(paused.state, "paused_approval");
    assert.deepEqual(paused.pendingProviderChoice, ["codex", "copilot"]); // every OTHER enabled provider, in order — not just "codex"
  });
});

test("A standing `auto start --pin` never pauses to ask — exactly today's pre-Phase-9 behavior, unchanged", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-pinned" }));
    const coordinator = new AutomaticHandoffCoordinator({
      store: ctx.store,
      adapters: { codex },
      getUsageStatus: usageMap({ codex: AVAILABLE }),
      checkProviderActivity: async () => CONFIRMED_IDLE,
    });

    const state = await coordinator.start(taskId, { pinnedProvider: "codex" });
    assert.equal(state.state, "completed");
    assert.equal(state.pendingProviderChoice, null);
    assert.equal(codex.calls.length, 1);
  });
});

test("A one-time resume pin is consumed after one selection — never left set on the completed state (full re-ask-after-failure coverage lives in autoCoordinator.test.ts)", async () => {
  await withEnv(async (ctx) => {
    const { taskId } = await setupAutoTask(ctx.store, ctx.repoRoot, "claude");
    const codex = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-once" }));
    const coordinator = new AutomaticHandoffCoordinator({
      store: ctx.store,
      adapters: { codex },
      getUsageStatus: usageMap({ codex: AVAILABLE }),
      checkProviderActivity: async () => CONFIRMED_IDLE,
    });

    const paused = await coordinator.start(taskId);
    assert.deepEqual(paused.pendingProviderChoice, ["codex"]);

    const afterResume = await coordinator.resume(taskId, { pin: "codex" as SessionProvider });
    // currentProvider is now "codex"; had the pin stayed sticky, the next
    // selectAndAdvance would try to pin to "codex" again — invalid, since
    // it now equals currentProvider. Confirms it was cleared instead.
    assert.equal(afterResume.state, "completed");
    assert.equal(afterResume.pinnedProvider, null);
  });
});
