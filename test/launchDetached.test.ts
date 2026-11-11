import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { launchDetached } from "../src/execution/launchDetached.js";

test("launchDetached: a nonexistent binary reports launched:false with the spawn error, not a false 'launched'", async () => {
  const result = await launchDetached({ command: "definitely-not-a-real-binary-xyz", args: [], cwd: process.cwd() });
  assert.equal(result.launched, false);
  assert.match(result.error ?? "", /ENOENT|not found/i);
});

test("launchDetached: a successful fake spawn resolves launched:true with the pid, never waiting for exit", async () => {
  const fakeChild = Object.assign(new EventEmitter(), { pid: 4242, unref: () => {} });
  const result = await launchDetached({ command: "claude", args: ["--desktop"], cwd: "/tmp" }, () => fakeChild as never);
  assert.equal(result.launched, true);
  assert.equal(result.pid, 4242);
  assert.equal(result.error, null);
});
