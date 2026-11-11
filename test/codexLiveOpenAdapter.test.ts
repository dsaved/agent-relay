import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexLiveOpenAdapter } from "../src/execution/codexLiveOpenAdapter.js";
import type { LaunchDetachedResult } from "../src/execution/launchDetached.js";
import type { SpawnRunResult } from "../src/execution/spawnRun.js";

function fakeLaunch(result: Partial<LaunchDetachedResult>) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const full: LaunchDetachedResult = { launched: true, pid: 1, error: null, ...result };
  return { fn: async (opts: { command: string; args: string[]; cwd: string }) => (calls.push(opts), full), calls };
}

function fakeQueue(result: Partial<SpawnRunResult>) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const full: SpawnRunResult = { exitCode: 0, signal: null, events: [], stderr: "", timedOut: false, outputTruncated: false, spawnError: null, cancelled: false, cancelReason: null, ...result };
  return { fn: async (opts: { command: string; args: string[]; cwd: string }) => (calls.push(opts), full), calls };
}

test("CodexLiveOpenAdapter: no resumeSessionId -> only `codex app <cwd>` fires, instruction is NOT seeded", async () => {
  const launch = fakeLaunch({ launched: true, pid: 1, error: null });
  const queue = fakeQueue({});
  const adapter = new CodexLiveOpenAdapter(launch.fn, queue.fn);
  const result = await adapter.open({ cwd: "/repo", instruction: "do the thing" });
  assert.equal(queue.calls.length, 0);
  assert.deepEqual(launch.calls[0], { command: "codex", args: ["app", "/repo"], cwd: "/repo" });
  assert.equal(result.sessionId, null);
  assert.equal(result.seeded, false);
  assert.match(result.detail, /NOT seeded/);
});

test("CodexLiveOpenAdapter: with a known thread, queues the message then fires `codex app`", async () => {
  const launch = fakeLaunch({ launched: true, pid: 1, error: null });
  const queue = fakeQueue({ exitCode: 0 });
  const adapter = new CodexLiveOpenAdapter(launch.fn, queue.fn);
  const result = await adapter.open({ cwd: "/repo", instruction: "continue", resumeSessionId: "thread-1" });
  assert.deepEqual(queue.calls[0], { command: "codex", args: ["queue", "--thread", "thread-1", "--message", "continue"], cwd: "/repo" });
  assert.deepEqual(launch.calls[0], { command: "codex", args: ["app", "/repo"], cwd: "/repo" });
  assert.equal(result.sessionId, "thread-1");
  assert.equal(result.launched, true);
  assert.equal(result.seeded, true);
});

test("CodexLiveOpenAdapter: a failing queue never fires `codex app` and is reported as not launched", async () => {
  const launch = fakeLaunch({ launched: true, pid: 1, error: null });
  const queue = fakeQueue({ exitCode: 1, stderr: "no such thread" });
  const adapter = new CodexLiveOpenAdapter(launch.fn, queue.fn);
  const result = await adapter.open({ cwd: "/repo", instruction: "continue", resumeSessionId: "thread-1" });
  assert.equal(launch.calls.length, 0);
  assert.equal(result.launched, false);
  assert.match(result.detail, /no such thread/);
});
