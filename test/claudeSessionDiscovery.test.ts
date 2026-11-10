import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverClaudeSessions } from "../src/sessions/claudeDiscovery.js";

test("discoverClaudeSessions: happy path maps a real-shaped `claude agents --json` array", async () => {
  const fixture = JSON.stringify([
    { pid: 111, cwd: "/tmp/proj-a", kind: "interactive", startedAt: 1700000000000, sessionId: "aaaa-1", name: "Fix the thing", status: "idle" },
    { pid: 222, cwd: "/tmp/proj-b", kind: "background", startedAt: 1700000001000, sessionId: "bbbb-2", name: "Other task", status: "busy" },
  ]);
  const result = await discoverClaudeSessions(() => Promise.resolve(fixture));

  assert.equal(result.error, undefined);
  assert.equal(result.sessions.length, 2);
  assert.deepEqual(result.sessions[0], {
    provider: "claude",
    sessionId: "aaaa-1",
    projectDir: "/tmp/proj-a",
    status: "idle",
    lastActivity: 1700000000000,
    discoverySource: "claude-cli:agents --json",
    pid: 111,
    title: "Fix the thing",
    providerGitInfo: null,
  });
});

test("discoverClaudeSessions: entries missing a sessionId are skipped, not fatal", async () => {
  const fixture = JSON.stringify([{ pid: 1, cwd: "/tmp/x" }, { pid: 2, cwd: "/tmp/y", sessionId: "ok-1", status: "idle" }]);
  const result = await discoverClaudeSessions(() => Promise.resolve(fixture));
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.sessionId, "ok-1");
});

test("discoverClaudeSessions: malformed (non-JSON) output -> error, empty sessions, no throw", async () => {
  const result = await discoverClaudeSessions(() => Promise.resolve("not json at all {{"));
  assert.equal(result.sessions.length, 0);
  assert.match(result.error ?? "", /valid JSON/);
});

test("discoverClaudeSessions: malformed (JSON but not an array) output -> error", async () => {
  const result = await discoverClaudeSessions(() => Promise.resolve(JSON.stringify({ oops: true })));
  assert.equal(result.sessions.length, 0);
  assert.match(result.error ?? "", /not an array/);
});

test("discoverClaudeSessions: unavailable CLI (spawn rejects) -> error, never thrown", async () => {
  const result = await discoverClaudeSessions(() => Promise.reject(new Error("`claude` CLI was not found on PATH")));
  assert.equal(result.sessions.length, 0);
  assert.match(result.error ?? "", /not found on PATH/);
});
