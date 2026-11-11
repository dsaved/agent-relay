import { test } from "node:test";
import assert from "node:assert/strict";
import { planSetup, applySetup, statusAll, repairAll, uninstallAll, formatSetupPlan, formatApplyOutcomes } from "../src/setup/run.js";
import type { ApplyResult, DetectionResult, IntegrationAdapter, IntegrationChange, IntegrationStatus } from "../src/setup/adapter.js";

/** A scripted, in-memory stand-in for an IntegrationAdapter — never a real config file or process, per this phase's own instruction not to touch a real Claude/Codex config while testing. */
class FakeAdapter implements IntegrationAdapter {
  installedState = false;
  applyCount = 0;
  uninstallCount = 0;
  statusValue: IntegrationStatus["entries"][number]["status"] = "missing";
  planShouldThrow = false;

  constructor(readonly id: string) {}

  async detect(): Promise<DetectionResult> {
    return { installed: this.installedState, version: "1.0", detail: this.installedState ? "found" : "not found" };
  }
  async plan(): Promise<IntegrationChange[]> {
    if (this.planShouldThrow) throw new Error("deliberate plan failure");
    return this.statusValue === "installed" ? [] : [{ kind: "add_hook", filePath: "/fake", description: `add for ${this.id}` }];
  }
  async apply(): Promise<ApplyResult> {
    this.applyCount++;
    this.statusValue = "installed";
    return { applied: [{ kind: "add_hook", filePath: "/fake", description: `added for ${this.id}` }], backupPaths: [`/fake/${this.id}.bak`], noopAlreadyUpToDate: false };
  }
  async status(): Promise<IntegrationStatus> {
    return { id: this.id, detection: await this.detect(), entries: [{ change: { kind: "add_hook", filePath: "/fake", description: this.id }, status: this.statusValue, detail: "" }] };
  }
  async repair(): Promise<ApplyResult> {
    return this.apply();
  }
  async uninstall(): Promise<ApplyResult> {
    this.uninstallCount++;
    this.statusValue = "missing";
    return { applied: [{ kind: "remove_hook", filePath: "/fake", description: `removed for ${this.id}` }], backupPaths: [`/fake/${this.id}.bak2`], noopAlreadyUpToDate: false };
  }
}

test("planSetup(): an adapter that isn't installed is reported, but never asked to plan", async () => {
  const a = new FakeAdapter("a");
  a.installedState = false;
  const summaries = await planSetup([a]);
  assert.equal(summaries[0]!.detection.installed, false);
  assert.deepEqual(summaries[0]!.changes, []);
});

test("planSetup(): a plan() failure is surfaced as planError, not thrown out of planSetup itself", async () => {
  const a = new FakeAdapter("a");
  a.installedState = true;
  a.planShouldThrow = true;
  const summaries = await planSetup([a]);
  assert.match(summaries[0]!.planError ?? "", /deliberate plan failure/);
});

test("applySetup(): only applies adapters with real changes and no planError; others are skipped entirely", async () => {
  const withChanges = new FakeAdapter("with-changes");
  withChanges.installedState = true;
  const upToDate = new FakeAdapter("up-to-date");
  upToDate.installedState = true;
  upToDate.statusValue = "installed"; // plan() will return []
  const broken = new FakeAdapter("broken-plan");
  broken.installedState = true;
  broken.planShouldThrow = true;

  const adapters = [withChanges, upToDate, broken];
  const summaries = await planSetup(adapters);
  const outcomes = await applySetup(adapters, summaries);

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.adapterId, "with-changes");
  assert.equal(withChanges.applyCount, 1);
  assert.equal(upToDate.applyCount, 0);
  assert.equal(broken.applyCount, 0);
});

test("statusAll(): aggregates every adapter's status independently", async () => {
  const a = new FakeAdapter("a");
  a.statusValue = "installed";
  const b = new FakeAdapter("b");
  b.statusValue = "missing";
  const statuses = await statusAll([a, b]);
  assert.equal(statuses.find((s) => s.id === "a")!.entries[0]!.status, "installed");
  assert.equal(statuses.find((s) => s.id === "b")!.entries[0]!.status, "missing");
});

test("repairAll(): only calls repair() on adapters whose status is missing/broken", async () => {
  const fine = new FakeAdapter("fine");
  fine.statusValue = "installed";
  const broken = new FakeAdapter("broken");
  broken.statusValue = "broken";

  const outcomes = await repairAll([fine, broken]);
  assert.equal(outcomes.find((o) => o.adapterId === "fine")!.repaired, false);
  assert.equal(fine.applyCount, 0);
  assert.equal(outcomes.find((o) => o.adapterId === "broken")!.repaired, true);
  assert.equal(broken.applyCount, 1);
});

test("uninstallAll(): calls uninstall() on every adapter, regardless of current status", async () => {
  const a = new FakeAdapter("a");
  const b = new FakeAdapter("b");
  await uninstallAll([a, b]);
  assert.equal(a.uninstallCount, 1);
  assert.equal(b.uninstallCount, 1);
});

test("formatSetupPlan/formatApplyOutcomes produce readable, non-empty text for a real plan+apply pair", async () => {
  const a = new FakeAdapter("a");
  a.installedState = true;
  const summaries = await planSetup([a]);
  const planText = formatSetupPlan(summaries);
  assert.match(planText, /add for a/);

  const outcomes = await applySetup([a], summaries);
  const applyText = formatApplyOutcomes(outcomes);
  assert.match(applyText, /added for a/);
  assert.match(applyText, /backup saved/);
});
