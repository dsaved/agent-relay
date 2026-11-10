import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { interpretCodexRun, interpretClaudeRun } from "../src/execution/outcomeClassifier.js";
import type { SpawnRunResult } from "../src/execution/spawnRun.js";
import type { ExecutionEvent } from "../src/execution/types.js";

const fixturesDir = join(process.cwd(), "fixtures");

function loadEvents(name: string): ExecutionEvent[] {
  return readFileSync(join(fixturesDir, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ observedAt: Date.now(), raw: JSON.parse(line) }));
}

function spawnResult(events: ExecutionEvent[], overrides: Partial<SpawnRunResult> = {}): SpawnRunResult {
  return { exitCode: 0, signal: null, events, stderr: "", timedOut: false, outputTruncated: false, spawnError: null, cancelled: false, cancelReason: null, ...overrides };
}

test("interpretCodexRun on the real exec --json usage-limit capture (Phase 0) classifies as rate_limited", () => {
  const { outcome } = interpretCodexRun(spawnResult(loadEvents("codex-usage-limit.jsonl"), { exitCode: 1 }));
  assert.equal(outcome.kind, "rate_limited");
  assert.match(outcome.detail ?? "", /usage limit/i);
});

test("interpretCodexRun on the documented agent_message success shape (Phase 0/2A) classifies as completed", () => {
  const { outcome, sessionId } = interpretCodexRun(spawnResult(loadEvents("codex-success.jsonl")));
  assert.equal(outcome.kind, "completed");
  assert.equal(sessionId, "01a1c49a-0000-0000-0000-000000000000");
});

test("interpretClaudeRun on the real stream-json 'allowed' capture (Phase 0) classifies as completed", () => {
  const { outcome, sessionId } = interpretClaudeRun(spawnResult(loadEvents("claude-rate-limit-ok.jsonl")));
  assert.equal(outcome.kind, "completed");
  assert.equal(sessionId, "cf6e5e42-2ac3-4ce0-a119-9daa1e0a56af");
});

test("interpretClaudeRun on the mocked 'rejected' rate-limit capture (Phase 0) classifies as rate_limited with a real cooldown timestamp", () => {
  const { outcome } = interpretClaudeRun(spawnResult(loadEvents("claude-rate-limit-exhausted.jsonl")));
  assert.equal(outcome.kind, "rate_limited");
  assert.equal(outcome.cooldownResetsAt, 1794311400);
});

test("interpretCodexRun: a spawn failure (CLI missing) is reported as crashed, never thrown", () => {
  const { outcome } = interpretCodexRun(spawnResult([], { spawnError: new Error("codex CLI was not found on PATH"), exitCode: null }));
  assert.equal(outcome.kind, "crashed");
});

test("interpretClaudeRun: zero valid events and exit 0 is invalid_output, not silently completed", () => {
  const { outcome } = interpretClaudeRun(spawnResult([], { exitCode: 0 }));
  assert.equal(outcome.kind, "invalid_output");
});
