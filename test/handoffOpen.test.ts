import { test } from "node:test";
import assert from "node:assert/strict";
import { openHandoffLive } from "../src/handoff/openHandoff.js";
import { createHandoffRecord } from "../src/handoff/prepare.js";
import { HandoffStore } from "../src/handoff/store.js";
import { withTempRepo } from "./helpers/tempGitRepo.js";
import { withTempStoreRoot, makeSessionAssociation } from "./helpers/tempHandoffEnv.js";
import { CONFIRMED_IDLE, CONFIRMED_BUSY } from "./helpers/autoTestEnv.js";
import type { LiveOpenAdapter, LiveOpenOptions, LiveOpenResult } from "../src/execution/types.js";

class FakeLiveOpenAdapter implements LiveOpenAdapter {
  readonly provider = "claude" as const;
  calls: LiveOpenOptions[] = [];
  constructor(private readonly result: LiveOpenResult) {}
  async open(options: LiveOpenOptions): Promise<LiveOpenResult> {
    this.calls.push(options);
    return this.result;
  }
}

async function withEnv(run: (ctx: { repoRoot: string; store: HandoffStore }) => Promise<void>): Promise<void> {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      await run({ repoRoot, store: new HandoffStore(storeRoot) });
    });
  });
}

async function prepare(repoRoot: string, store: HandoffStore): Promise<string> {
  const session = makeSessionAssociation({ provider: "codex", repoRoot, workspaceAccessible: true, title: "Implement the thing" });
  const { task, handoff } = await createHandoffRecord(session);
  await store.saveTask(task);
  await store.saveHandoff(handoff);
  return handoff.handoffId;
}

test("handoff open: a confirmed-busy workspace is refused without --force-open, and the adapter is never called", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const handoffId = await prepare(repoRoot, store);
    const claude = new FakeLiveOpenAdapter({ launched: true, command: [], sessionId: null, seeded: false, detail: "" });
    const result = await openHandoffLive(handoffId, { to: "claude" }, { store, adapters: { claude }, checkProviderActivity: async () => CONFIRMED_BUSY });
    assert.ok(result.blockedReason);
    assert.equal(claude.calls.length, 0);
  });
});

test("handoff open: --force-open overrides a busy signal and launches", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const handoffId = await prepare(repoRoot, store);
    const claude = new FakeLiveOpenAdapter({ launched: true, command: ["claude", "--desktop"], sessionId: null, seeded: false, detail: "launched" });
    const result = await openHandoffLive(handoffId, { to: "claude", forceOpenOverride: true }, { store, adapters: { claude }, checkProviderActivity: async () => CONFIRMED_BUSY });
    assert.equal(result.blockedReason, undefined);
    assert.equal(claude.calls.length, 1);
  });
});

test("handoff open: a successful open registers a desktop session (external_active) and sets handoff.status to opened_live", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const handoffId = await prepare(repoRoot, store);
    const claude = new FakeLiveOpenAdapter({ launched: true, command: ["claude", "--desktop", "x"], sessionId: null, seeded: false, detail: "launched claude --desktop" });
    const result = await openHandoffLive(handoffId, { to: "claude" }, { store, adapters: { claude }, checkProviderActivity: async () => CONFIRMED_IDLE });

    assert.equal(result.blockedReason, undefined);
    assert.equal(result.handoff.status, "opened_live");
    assert.equal(result.handoff.destinationProvider, "claude");
    assert.ok(result.desktopRecord);
    assert.equal(result.desktopRecord!.ownershipStatus, "external_active");
    assert.match(result.desktopRecord!.evidence[result.desktopRecord!.evidence.length - 1]!.detail, /launched claude --desktop/);

    const reloaded = await store.loadHandoff(handoffId);
    assert.equal(reloaded!.status, "opened_live");
  });
});

test("handoff open: a provider with no registered adapter is refused outright, before any activity check runs", async () => {
  await withEnv(async ({ repoRoot, store }) => {
    const handoffId = await prepare(repoRoot, store);
    let activityChecked = false;
    const result = await openHandoffLive(handoffId, { to: "copilot" }, { store, adapters: {}, checkProviderActivity: async () => ((activityChecked = true), CONFIRMED_IDLE) });
    assert.match(result.blockedReason ?? "", /no live-open adapter/);
    assert.equal(activityChecked, false);
  });
});
