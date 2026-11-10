import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHandoffRecord } from "../src/handoff/prepare.js";
import { HandoffStore } from "../src/handoff/store.js";
import { HandoffEngine } from "../src/handoff/engine.js";
import type { UsageSnapshot } from "../src/usage/types.js";
import { git, withTempRepo } from "./helpers/tempGitRepo.js";
import { makeSessionAssociation, withTempStoreRoot } from "./helpers/tempHandoffEnv.js";
import { FakeExecutionAdapter, fakeOutcome, fakeResult } from "./helpers/fakeExecutionAdapter.js";

const AVAILABLE: UsageSnapshot = { classification: "available", observedAt: Date.now(), primary: null, secondary: null };

test("source files are preserved exactly when a handoff is blocked before execution — not touched, not deleted", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeFile(join(repoRoot, "src.ts"), "export const partial = 1;\n");
    git(["add", "src.ts"], repoRoot);

    await withTempStoreRoot(async (storeRoot) => {
      const store = new HandoffStore(storeRoot);
      const session = makeSessionAssociation({ provider: "codex", repoRoot, workspaceAccessible: true });
      const { task, handoff } = await createHandoffRecord(session);
      await store.saveTask(task);
      await store.saveHandoff(handoff);

      const dest = new FakeExecutionAdapter("claude", () => fakeResult("claude"));
      const engine = new HandoffEngine({
        store,
        adapters: { claude: dest },
        getUsageStatus: async () => ({ classification: "exhausted", observedAt: Date.now(), primary: null, secondary: null }), // forces a block
      });

      const result = await engine.executeHandoff(handoff.handoffId, { to: "claude" });
      assert.equal(result.handoff.status, "blocked");
      assert.equal(dest.calls.length, 0);
    });

    const content = await readFile(join(repoRoot, "src.ts"), "utf8");
    assert.equal(content, "export const partial = 1;\n");
  });
});

test("destination failure after partial code modifications: files the destination already wrote survive a subsequent crash, nothing is rolled back", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeFile(join(repoRoot, "src.ts"), "export const partial = 1;\n");
    git(["add", "src.ts"], repoRoot);

    await withTempStoreRoot(async (storeRoot) => {
      const store = new HandoffStore(storeRoot);
      const session = makeSessionAssociation({ provider: "codex", repoRoot, workspaceAccessible: true });
      const { task, handoff } = await createHandoffRecord(session);
      await store.saveTask(task);
      await store.saveHandoff(handoff);

      const dest = new FakeExecutionAdapter("claude", async () => {
        // Simulate the destination agent having genuinely done partial work before dying mid-turn.
        await writeFile(join(repoRoot, "src.ts"), "export const partial = 1;\nexport const addedByDestination = 2;\n");
        return fakeResult("claude", { sessionId: "claude-partial-work", outcome: fakeOutcome("crashed", "simulated mid-turn crash") });
      });
      const engine = new HandoffEngine({
        store,
        adapters: { claude: dest },
        getUsageStatus: async () => AVAILABLE,
        checkProviderActivity: async () => ({ status: "confirmed_idle", reason: "no activity signal configured for this test" }),
      });

      const result = await engine.executeHandoff(handoff.handoffId, { to: "claude" });
      assert.equal(result.handoff.status, "interrupted");
      assert.equal(result.attempt.destinationSessionId, "claude-partial-work");
    });

    const content = await readFile(join(repoRoot, "src.ts"), "utf8");
    assert.match(content, /addedByDestination/, "the engine must never revert a destination's partial work after a crash");
  });
});
