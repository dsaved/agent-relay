import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeLiveOpenAdapter } from "../src/execution/claudeLiveOpenAdapter.js";
import type { LaunchDetachedResult } from "../src/execution/launchDetached.js";

function fakeLaunch(result: Partial<LaunchDetachedResult>) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const full: LaunchDetachedResult = { launched: true, pid: 1, error: null, ...result };
  return { fn: async (opts: { command: string; args: string[]; cwd: string }) => (calls.push(opts), full), calls };
}

test("ClaudeLiveOpenAdapter: a brand-new session builds `claude --desktop`, with no --resume and no prompt (live-confirmed: --desktop rejects a prompt)", async () => {
  const launch = fakeLaunch({ launched: true, pid: 1, error: null });
  const adapter = new ClaudeLiveOpenAdapter(launch.fn);
  const result = await adapter.open({ cwd: "/repo", instruction: "do the thing" });
  assert.deepEqual(launch.calls[0], { command: "claude", args: ["--desktop"], cwd: "/repo" });
  assert.deepEqual(result.command, ["claude", "--desktop"]);
  assert.equal(result.sessionId, null);
  assert.equal(result.launched, true);
  assert.equal(result.seeded, false);
});

test("ClaudeLiveOpenAdapter: resuming an existing session adds --resume <id>, still no prompt", async () => {
  const launch = fakeLaunch({ launched: true, pid: 1, error: null });
  const adapter = new ClaudeLiveOpenAdapter(launch.fn);
  const result = await adapter.open({ cwd: "/repo", instruction: "continue", resumeSessionId: "sess-123" });
  assert.deepEqual(launch.calls[0]!.args, ["--desktop", "--resume", "sess-123"]);
  assert.equal(result.sessionId, "sess-123");
  assert.equal(result.seeded, false);
});

test("ClaudeLiveOpenAdapter: a failed launch is reported honestly, not as success", async () => {
  const launch = fakeLaunch({ launched: false, pid: null, error: "claude not found on PATH" });
  const adapter = new ClaudeLiveOpenAdapter(launch.fn);
  const result = await adapter.open({ cwd: "/repo", instruction: "do the thing" });
  assert.equal(result.launched, false);
  assert.match(result.detail, /claude not found on PATH/);
});
