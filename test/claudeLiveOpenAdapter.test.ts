import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeLiveOpenAdapter } from "../src/execution/claudeLiveOpenAdapter.js";
import type { LaunchDetachedResult } from "../src/execution/launchDetached.js";

function fakeLaunch(result: LaunchDetachedResult) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  return { fn: async (opts: { command: string; args: string[]; cwd: string }) => (calls.push(opts), result), calls };
}

test("ClaudeLiveOpenAdapter: a brand-new session builds `claude --desktop <instruction>`, no --resume", async () => {
  const launch = fakeLaunch({ launched: true, pid: 1, error: null });
  const adapter = new ClaudeLiveOpenAdapter(launch.fn);
  const result = await adapter.open({ cwd: "/repo", instruction: "do the thing" });
  assert.deepEqual(launch.calls[0], { command: "claude", args: ["--desktop", "do the thing"], cwd: "/repo" });
  assert.deepEqual(result.command, ["claude", "--desktop", "do the thing"]);
  assert.equal(result.sessionId, null);
  assert.equal(result.launched, true);
});

test("ClaudeLiveOpenAdapter: resuming an existing session adds --resume <id> before the instruction", async () => {
  const launch = fakeLaunch({ launched: true, pid: 1, error: null });
  const adapter = new ClaudeLiveOpenAdapter(launch.fn);
  const result = await adapter.open({ cwd: "/repo", instruction: "continue", resumeSessionId: "sess-123" });
  assert.deepEqual(launch.calls[0]!.args, ["--desktop", "--resume", "sess-123", "continue"]);
  assert.equal(result.sessionId, "sess-123");
});

test("ClaudeLiveOpenAdapter: a failed launch is reported honestly, not as success", async () => {
  const launch = fakeLaunch({ launched: false, pid: null, error: "claude not found on PATH" });
  const adapter = new ClaudeLiveOpenAdapter(launch.fn);
  const result = await adapter.open({ cwd: "/repo", instruction: "do the thing" });
  assert.equal(result.launched, false);
  assert.match(result.detail, /claude not found on PATH/);
});
