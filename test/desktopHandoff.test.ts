import { test } from "node:test";
import assert from "node:assert/strict";
import { requestDesktopHandoff } from "../src/desktop/handoff.js";
import { DesktopRegistry } from "../src/desktop/registry.js";
import { HandoffEngine } from "../src/handoff/engine.js";
import { HandoffStore } from "../src/handoff/store.js";
import { WorkspaceLockManager } from "../src/handoff/lock.js";
import type { DiscoverAllResult } from "../src/sessions/discoverAll.js";
import type { SessionAssociation } from "../src/sessions/types.js";
import { withTempRepo } from "./helpers/tempGitRepo.js";
import { withTempStoreRoot, makeSessionAssociation } from "./helpers/tempHandoffEnv.js";
import { FakeExecutionAdapter, fakeResult } from "./helpers/fakeExecutionAdapter.js";
import { AVAILABLE, usageMap, CONFIRMED_IDLE, CONFIRMED_BUSY, UNKNOWN_ACTIVITY } from "./helpers/autoTestEnv.js";

function discoverFrom(sessions: SessionAssociation[]): () => Promise<DiscoverAllResult> {
  return async () => ({ sessions, errors: [] });
}

async function withEnv(run: (ctx: { repoRoot: string; store: HandoffStore }) => Promise<void>): Promise<void> {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      await run({ repoRoot, store: new HandoffStore(storeRoot) });
    });
  });
}

test("desktop handoff: confirmed idle + authorized -> reuses HandoffEngine and completes, exactly like `handoff execute`", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const session = makeSessionAssociation({ sessionId: "desk-h1", provider: "codex", repoRoot, workspaceAccessible: true, title: "Implement the thing" });
    const lockManager = new WorkspaceLockManager(store);
    const registry = new DesktopRegistry({ store, lockManager, discover: discoverFrom([session]), checkProviderActivity: async () => CONFIRMED_IDLE });
    await registry.register("desk-h1");

    const claude = new FakeExecutionAdapter("claude", () => fakeResult("claude", { sessionId: "claude-desktop-1" }));
    const engine = new HandoffEngine({ store, lockManager, adapters: { claude }, getUsageStatus: usageMap({ claude: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_IDLE });

    const result = await requestDesktopHandoff("desk-h1", { to: "claude" }, { registry, store, engine });
    assert.equal(result.blockedReason, undefined);
    assert.equal(claude.calls.length, 1);
    assert.equal(result.record.ownershipStatus, "released");

    const handoff = await store.loadHandoff(result.handoffId!);
    assert.equal(handoff!.status, "completed");
  });
});

test("desktop handoff: confirmed busy + no --force-lock -> blocked before HandoffEngine is ever called", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const session = makeSessionAssociation({ sessionId: "desk-h2", provider: "codex", repoRoot, workspaceAccessible: true, title: "Implement the thing" });
    const lockManager = new WorkspaceLockManager(store);
    const registry = new DesktopRegistry({ store, lockManager, discover: discoverFrom([session]), checkProviderActivity: async () => CONFIRMED_BUSY });
    await registry.register("desk-h2");

    const claude = new FakeExecutionAdapter("claude", () => fakeResult("claude"));
    const engine = new HandoffEngine({ store, lockManager, adapters: { claude }, getUsageStatus: usageMap({ claude: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_BUSY });

    const result = await requestDesktopHandoff("desk-h2", { to: "claude" }, { registry, store, engine });
    assert.match(result.blockedReason ?? "", /ownership could not be confirmed safe/);
    assert.equal(claude.calls.length, 0, "a blocked desktop handoff must never invoke the destination adapter");
  });
});

test("desktop handoff: unknown liveness (ordinary Codex thread history) is blocked, never silently treated as safe", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const session = makeSessionAssociation({ sessionId: "desk-h3", provider: "codex", repoRoot, workspaceAccessible: true, title: "Implement the thing" });
    const lockManager = new WorkspaceLockManager(store);
    const registry = new DesktopRegistry({ store, lockManager, discover: discoverFrom([session]), checkProviderActivity: async () => UNKNOWN_ACTIVITY });
    await registry.register("desk-h3");

    const claude = new FakeExecutionAdapter("claude", () => fakeResult("claude"));
    const engine = new HandoffEngine({ store, lockManager, adapters: { claude }, getUsageStatus: usageMap({ claude: AVAILABLE }), checkProviderActivity: async () => UNKNOWN_ACTIVITY });

    const result = await requestDesktopHandoff("desk-h3", { to: "claude" }, { registry, store, engine });
    assert.ok(result.blockedReason);
    assert.equal(claude.calls.length, 0);
  });
});

test("desktop handoff: --force-lock is the only thing that proceeds past a busy signal, and it is never implied automatically", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const session = makeSessionAssociation({ sessionId: "desk-h4", provider: "codex", repoRoot, workspaceAccessible: true, title: "Implement the thing" });
    const lockManager = new WorkspaceLockManager(store);
    const registry = new DesktopRegistry({ store, lockManager, discover: discoverFrom([session]), checkProviderActivity: async () => CONFIRMED_BUSY });
    await registry.register("desk-h4");

    const claude = new FakeExecutionAdapter("claude", () => fakeResult("claude", { sessionId: "claude-forced-1" }));
    const engine = new HandoffEngine({ store, lockManager, adapters: { claude }, getUsageStatus: usageMap({ claude: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_BUSY });

    const withoutForce = await requestDesktopHandoff("desk-h4", { to: "claude" }, { registry, store, engine });
    assert.ok(withoutForce.blockedReason);
    assert.equal(claude.calls.length, 0);

    const withForce = await requestDesktopHandoff("desk-h4", { to: "claude", forceLockOverride: true }, { registry, store, engine });
    assert.equal(withForce.blockedReason, undefined);
    assert.equal(claude.calls.length, 1);
  });
});

test("desktop handoff: a prior registration's objective is what HandoffEngine receives — never invented", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const session = makeSessionAssociation({ sessionId: "desk-h5", provider: "codex", repoRoot, workspaceAccessible: true, title: "A very specific objective" });
    const lockManager = new WorkspaceLockManager(store);
    const registry = new DesktopRegistry({ store, lockManager, discover: discoverFrom([session]), checkProviderActivity: async () => CONFIRMED_IDLE });
    await registry.register("desk-h5");

    let receivedInstruction = "";
    const claude = new FakeExecutionAdapter("claude", (options) => {
      receivedInstruction = options.instruction;
      return fakeResult("claude", { sessionId: "claude-objective-1" });
    });
    const engine = new HandoffEngine({ store, lockManager, adapters: { claude }, getUsageStatus: usageMap({ claude: AVAILABLE }), checkProviderActivity: async () => CONFIRMED_IDLE });

    await requestDesktopHandoff("desk-h5", { to: "claude" }, { registry, store, engine });
    assert.match(receivedInstruction, /A very specific objective/);
  });
});
