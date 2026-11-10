import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWorkspaceActivity } from "../src/handoff/engine.js";
import type { SessionAssociation } from "../src/sessions/types.js";

function session(overrides: Partial<SessionAssociation>): SessionAssociation {
  return {
    provider: "codex",
    sessionId: "s-1",
    projectDir: "/tmp/x",
    status: "idle",
    lastActivity: null,
    discoverySource: "test",
    pid: null,
    title: null,
    providerGitInfo: null,
    repoRoot: "/tmp/x",
    worktreePath: null,
    workspaceAccessible: true,
    ...overrides,
  };
}

test("source session still active (Claude) is caught, not excluded, as confirmed_busy", () => {
  const signal = classifyWorkspaceActivity([session({ provider: "claude", sessionId: "the-source-session", status: "busy" })]);
  assert.equal(signal.status, "confirmed_busy");
  assert.match(signal.reason, /the-source-session/);
});

test("source session still active (Codex, status active) is confirmed_busy", () => {
  const signal = classifyWorkspaceActivity([session({ provider: "codex", sessionId: "the-source-session", status: "active" })]);
  assert.equal(signal.status, "confirmed_busy");
});

test("Codex session present but not 'active' is 'unknown', never 'confirmed_idle' — thread/list cannot prove liveness", () => {
  for (const status of ["notLoaded", "idle", "systemError"]) {
    const signal = classifyWorkspaceActivity([session({ provider: "codex", status })]);
    assert.equal(signal.status, "unknown", `status "${status}" should be unknown`);
  }
});

test("Claude sessions present, none busy -> confirmed_idle (claude agents --json is a real liveness signal)", () => {
  const signal = classifyWorkspaceActivity([session({ provider: "claude", status: "idle" })]);
  assert.equal(signal.status, "confirmed_idle");
});

test("no sessions at all for this workspace -> confirmed_idle", () => {
  const signal = classifyWorkspaceActivity([]);
  assert.equal(signal.status, "confirmed_idle");
});

test("mixed: an idle Claude session plus any Codex presence still yields unknown overall (Codex's uncertainty dominates)", () => {
  const signal = classifyWorkspaceActivity([session({ provider: "claude", status: "idle" }), session({ provider: "codex", status: "notLoaded" })]);
  assert.equal(signal.status, "unknown");
});
