import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnRun } from "../src/execution/spawnRun.js";
import { isPidAlive } from "../src/handoff/lock.js";

/**
 * Proves the "parent/child process termination" requirement: a SIGTERM-
 * ignoring grandchild, spawned by the direct child without `detached`
 * (so it inherits the same POSIX process group), must still end up dead
 * once `spawnRun` times out and escalates — because the kill targets the
 * whole group (`-pid`), not just the one process it spawned directly.
 */
test("a timed-out run's descendants are stopped too, even ones that ignore SIGTERM", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-relay-procgroup-"));
  try {
    const script = [
      "const { spawn } = require('child_process');",
      "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000);']);",
      "console.log(JSON.stringify({ grandchildPid: child.pid }));",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const result = await spawnRun({ command: process.execPath, args: ["-e", script], cwd, timeoutMs: 200 });

    assert.equal(result.timedOut, true);
    const grandchildPid = (result.events[0]?.raw as { grandchildPid?: number } | undefined)?.grandchildPid;
    assert.equal(typeof grandchildPid, "number", "expected the grandchild's pid to have been reported before termination");

    // KILL_GRACE_MS inside spawnRun is 5s; give the SIGKILL escalation a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(isPidAlive(grandchildPid as number), false, "a SIGTERM-ignoring grandchild must still be dead after the group kill escalates to SIGKILL");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
