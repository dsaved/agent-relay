import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnRun } from "../src/execution/spawnRun.js";
import { isPidAlive } from "../src/handoff/lock.js";

/** Phase 4 requirement #5: cooperative cancellation must actually stop a genuinely in-flight process group, not just mark it cancelled in the result. */
test("aborting mid-run kills the process group and reports cancelled with the abort reason", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-relay-cancel-"));
  try {
    const controller = new AbortController();
    const resultPromise = spawnRun({
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({started: true})); setInterval(() => {}, 1000);"],
      cwd,
      signal: controller.signal,
    });

    // Give the child a moment to actually start before cancelling, so this
    // proves a real in-flight process was interrupted, not merely the
    // pre-spawn already-aborted fast path below.
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort("stop");

    const result = await resultPromise;
    assert.equal(result.cancelled, true);
    assert.equal(result.cancelReason, "stop");
    assert.equal(result.timedOut, false, "a cancellation must never be reported as a timeout");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an already-aborted signal never spawns a process at all", async () => {
  const controller = new AbortController();
  controller.abort("pause");
  const result = await spawnRun({ command: process.execPath, args: ["-e", "throw new Error('must never run')"], cwd: process.cwd(), signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.cancelReason, "pause");
  assert.equal(result.exitCode, null);
});

test("cancellation kills descendants too, same as a timeout escalation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-relay-cancel-desc-"));
  try {
    const controller = new AbortController();
    const script = [
      "const { spawn } = require('child_process');",
      "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000);']);",
      "console.log(JSON.stringify({ grandchildPid: child.pid }));",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const resultPromise = spawnRun({ command: process.execPath, args: ["-e", script], cwd, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort("stop");
    const result = await resultPromise;

    const grandchildPid = (result.events[0]?.raw as { grandchildPid?: number } | undefined)?.grandchildPid;
    assert.equal(typeof grandchildPid, "number");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(isPidAlive(grandchildPid as number), false, "a SIGTERM-ignoring grandchild must still be dead after a cancellation escalates to SIGKILL");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
