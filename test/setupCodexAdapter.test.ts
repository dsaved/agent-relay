import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexAdapter } from "../src/setup/codexAdapter.js";

test("detect(): reports installed/version from the injected check, never a real spawn in tests", async () => {
  const adapter = new CodexAdapter({ checkCliAvailable: async () => ({ installed: true, version: "0.159.2" }) });
  const detection = await adapter.detect();
  assert.equal(detection.installed, true);
  assert.equal(detection.version, "0.159.2");
});

test("plan() is always empty — Codex has no documented hook/config integration point", async () => {
  const adapter = new CodexAdapter({ checkCliAvailable: async () => ({ installed: true, version: null }) });
  assert.deepEqual(await adapter.plan(), []);
});

test("apply()/repair()/uninstall() are all no-ops, never pretending to write anything", async () => {
  const adapter = new CodexAdapter({ checkCliAvailable: async () => ({ installed: true, version: null }) });
  for (const result of [await adapter.apply(), await adapter.repair(), await adapter.uninstall()]) {
    assert.equal(result.noopAlreadyUpToDate, true);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.backupPaths, []);
  }
});

test("status() reports 'not_applicable', never a fabricated 'installed'", async () => {
  const adapter = new CodexAdapter({ checkCliAvailable: async () => ({ installed: true, version: "0.159.2" }) });
  const status = await adapter.status();
  assert.equal(status.entries[0]!.status, "not_applicable");
});

test("detect(): not installed is reported honestly", async () => {
  const adapter = new CodexAdapter({ checkCliAvailable: async () => ({ installed: false, version: null }) });
  const detection = await adapter.detect();
  assert.equal(detection.installed, false);
  assert.match(detection.detail, /not found on PATH/);
});
