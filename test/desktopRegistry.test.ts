import { test } from "node:test";
import assert from "node:assert/strict";
import { DesktopRegistry, DesktopSessionNotFoundError, MissingObjectiveError, inferOriginatingApp } from "../src/desktop/registry.js";
import { HandoffStore } from "../src/handoff/store.js";
import { WorkspaceLockManager } from "../src/handoff/lock.js";
import type { DiscoverAllResult } from "../src/sessions/discoverAll.js";
import type { SessionAssociation } from "../src/sessions/types.js";
import { withTempRepo } from "./helpers/tempGitRepo.js";
import { withTempStoreRoot, makeSessionAssociation } from "./helpers/tempHandoffEnv.js";
import { CONFIRMED_IDLE, CONFIRMED_BUSY, UNKNOWN_ACTIVITY } from "./helpers/autoTestEnv.js";

function discoverFrom(sessions: SessionAssociation[]): () => Promise<DiscoverAllResult> {
  return async () => ({ sessions, errors: [] });
}

function makeRegistry(store: HandoffStore, sessions: SessionAssociation[], checkProviderActivity = async () => CONFIRMED_IDLE): DesktopRegistry {
  return new DesktopRegistry({ store, lockManager: new WorkspaceLockManager(store), discover: discoverFrom(sessions), checkProviderActivity });
}

async function withEnv(run: (ctx: { repoRoot: string; store: HandoffStore }) => Promise<void>): Promise<void> {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      await run({ repoRoot, store: new HandoffStore(storeRoot) });
    });
  });
}

test("register(): uses the discovered session's own title as the objective when none is supplied", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const session = makeSessionAssociation({ sessionId: "desk-1", repoRoot, workspaceAccessible: true, title: "Fix the thing" });
    const record = await makeRegistry(store, [session]).register("desk-1");
    assert.equal(record.objective, "Fix the thing");
    assert.equal(record.ownershipStatus, "external_unmanaged");
  });
});

test("register(): requires an explicit --objective when the session has no title", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const session = makeSessionAssociation({ sessionId: "desk-2", repoRoot, workspaceAccessible: true, title: null });
    await assert.rejects(() => makeRegistry(store, [session]).register("desk-2"), MissingObjectiveError);
    const withOverride = await makeRegistry(store, [session]).register("desk-2", "supplied objective");
    assert.equal(withOverride.objective, "supplied objective");
  });
});

test("register(): an unknown session id is reported, not silently invented", async () => {
  await withEnv(async ({ store }) => {
    await assert.rejects(() => makeRegistry(store, []).register("nonexistent"), DesktopSessionNotFoundError);
  });
});

test("two sessions sharing a repoRoot register as two distinct records, never merged", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const a = makeSessionAssociation({ sessionId: "desk-a", repoRoot, workspaceAccessible: true, title: "Task A" });
    const b = makeSessionAssociation({ sessionId: "desk-b", repoRoot, workspaceAccessible: true, title: "Task B", provider: "claude" });
    const registry = makeRegistry(store, [a, b]);
    await registry.register("desk-a");
    await registry.register("desk-b");
    const all = await registry.list();
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((r) => r.sessionId).sort(), ["desk-a", "desk-b"]);
  });
});

test("recordEvidence(): appends to an existing record; returns null for one that was never registered", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const session = makeSessionAssociation({ sessionId: "desk-3", repoRoot, workspaceAccessible: true, title: "Task" });
    const registry = makeRegistry(store, [session]);
    await registry.register("desk-3");
    const updated = await registry.recordEvidence("desk-3", "test", "something happened");
    assert.equal(updated!.evidence.at(-1)!.detail, "something happened");
    assert.equal(await registry.recordEvidence("never-registered", "test", "x"), null);
  });
});

test("refreshOwnership(): authorizing now while confirmed idle moves to handoff_requested with canTakeOwnership true, re-derived fresh each call", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const session = makeSessionAssociation({ sessionId: "desk-4", repoRoot, workspaceAccessible: true, title: "Task" });
    const registry = makeRegistry(store, [session], async () => CONFIRMED_IDLE);
    await registry.register("desk-4");

    const authorized = await registry.refreshOwnership("desk-4", true);
    assert.equal(authorized.record.ownershipStatus, "handoff_requested");
    assert.equal(authorized.canTakeOwnership, true);

    // A later, non-authorizing check never silently escalates on the strength of the earlier authorization alone.
    const laterUnauthorized = await registry.refreshOwnership("desk-4", false);
    assert.equal(laterUnauthorized.canTakeOwnership, false);
  });
});

test("refreshOwnership(): authorizing while a session is confirmed busy stays blocked", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const session = makeSessionAssociation({ sessionId: "desk-5", repoRoot, workspaceAccessible: true, title: "Task" });
    const registry = makeRegistry(store, [session], async () => CONFIRMED_BUSY);
    await registry.register("desk-5");
    const { canTakeOwnership } = await registry.refreshOwnership("desk-5", true);
    assert.equal(canTakeOwnership, false);
  });
});

test("refreshOwnership(): unknown activity (e.g. ordinary Codex thread history) never silently confirms idle", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const session = makeSessionAssociation({ sessionId: "desk-6", repoRoot, workspaceAccessible: true, title: "Task", provider: "codex" });
    const registry = makeRegistry(store, [session], async () => UNKNOWN_ACTIVITY);
    await registry.register("desk-6");
    const { record, canTakeOwnership } = await registry.refreshOwnership("desk-6", true);
    assert.equal(canTakeOwnership, false);
    assert.equal(record.ownershipStatus, "handoff_requested");
  });
});

test("ensureTask(): creates a durable task/handoff on first call, reuses it on later calls", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const session = makeSessionAssociation({ sessionId: "desk-7", repoRoot, workspaceAccessible: true, title: "Task" });
    const registry = makeRegistry(store, [session]);
    await registry.register("desk-7");
    const first = await registry.ensureTask("desk-7");
    const second = await registry.ensureTask("desk-7");
    assert.deepEqual(second, first);
    const record = await registry.get("desk-7");
    assert.equal(record!.associatedTaskId, first.taskId);
  });
});

test("markReleased(): sets ownershipStatus to released and records an evidence entry", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const session = makeSessionAssociation({ sessionId: "desk-8", repoRoot, workspaceAccessible: true, title: "Task" });
    const registry = makeRegistry(store, [session]);
    await registry.register("desk-8");
    await registry.markReleased("desk-8", "some-task-id");
    const record = await registry.get("desk-8");
    assert.equal(record!.ownershipStatus, "released");
    assert.equal(record!.associatedTaskId, "some-task-id");
    assert.match(record!.evidence.at(-1)!.detail, /released cleanly/);
  });
});

test("inferOriginatingApp: names a Desktop originator when the discovery source carries one, else a sensible per-provider default", () => {
  const codexDesktop = makeSessionAssociation({ provider: "codex", discoverySource: "codex-app-server:thread/list (vscode / Codex Desktop)" });
  assert.equal(inferOriginatingApp(codexDesktop), "Codex Desktop");

  const codexCliOnly = makeSessionAssociation({ provider: "codex", discoverySource: "codex-app-server:thread/list" });
  assert.equal(inferOriginatingApp(codexCliOnly), "Codex CLI");

  const claude = makeSessionAssociation({ provider: "claude", discoverySource: "claude-cli:agents --json" });
  assert.equal(inferOriginatingApp(claude), "Claude Code CLI");
});
