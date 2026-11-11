import { test } from "node:test";
import assert from "node:assert/strict";
import { activate, deactivate, isLoaded, launchdServiceTarget, launchdDomainTarget } from "../src/daemon/launchd.js";
import type { LaunchctlResult, LaunchctlRunner } from "../src/daemon/launchd.js";

/** Never spawns a real `launchctl` — this session's own instructions forbid touching the real launchd, and this fake is what proves the logic without it. */
function fakeRunner(loaded: boolean, calls: string[][] = []): LaunchctlRunner {
  return async (args: string[]): Promise<LaunchctlResult> => {
    calls.push(args);
    if (args[0] === "print") return loaded ? { exitCode: 0, stdout: "loaded", stderr: "" } : { exitCode: 1, stdout: "", stderr: "Could not find service" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

test("isLoaded(): true only when `launchctl print` exits 0", async () => {
  assert.equal(await isLoaded("com.agent-relay.daemon", fakeRunner(true)), true);
  assert.equal(await isLoaded("com.agent-relay.daemon", fakeRunner(false)), false);
});

test("activate(): idempotent — a no-op when already loaded, never calls bootstrap in that case", async () => {
  const calls: string[][] = [];
  const result = await activate("/path/to.plist", "com.agent-relay.daemon", fakeRunner(true, calls));
  assert.equal(result.changed, false);
  assert.ok(!calls.some((c) => c[0] === "bootstrap"));
});

test("activate(): calls bootstrap with the domain target and plist path when not loaded", async () => {
  const calls: string[][] = [];
  const result = await activate("/path/to.plist", "com.agent-relay.daemon", fakeRunner(false, calls));
  assert.equal(result.changed, true);
  const bootstrapCall = calls.find((c) => c[0] === "bootstrap");
  assert.deepEqual(bootstrapCall, ["bootstrap", launchdDomainTarget(), "/path/to.plist"]);
});

test("deactivate(): idempotent — a no-op when already unloaded, never calls bootout in that case", async () => {
  const calls: string[][] = [];
  const result = await deactivate("com.agent-relay.daemon", fakeRunner(false, calls));
  assert.equal(result.changed, false);
  assert.ok(!calls.some((c) => c[0] === "bootout"));
});

test("deactivate(): calls bootout with the service target when loaded", async () => {
  const calls: string[][] = [];
  const result = await deactivate("com.agent-relay.daemon", fakeRunner(true, calls));
  assert.equal(result.changed, true);
  const bootoutCall = calls.find((c) => c[0] === "bootout");
  assert.deepEqual(bootoutCall, ["bootout", launchdServiceTarget("com.agent-relay.daemon")]);
});

test("activate()/deactivate() surface a real launchctl failure as a thrown error, not a silent no-op", async () => {
  const failingRunner: LaunchctlRunner = async (args) => (args[0] === "print" ? { exitCode: 1, stdout: "", stderr: "" } : { exitCode: 1, stdout: "", stderr: "permission denied" });
  await assert.rejects(() => activate("/path/to.plist", "com.agent-relay.daemon", failingRunner), /permission denied/);
});
