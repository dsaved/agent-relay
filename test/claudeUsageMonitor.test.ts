import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeUsageMonitor } from "../src/claude/usageMonitor.js";

const fixturesDir = join(process.cwd(), "fixtures");

function loadJsonl(name: string): unknown[] {
  return readFileSync(join(fixturesDir, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function alwaysAvailableCli() {
  return Promise.resolve(true);
}

test("ClaudeUsageMonitor: no observation yet -> unknown, never guesses available", async () => {
  const monitor = new ClaudeUsageMonitor(undefined, alwaysAvailableCli);
  const status = await monitor.getStatus();
  assert.equal(status.classification, "unknown");
  assert.equal(status.observedAt, null);
  assert.match(status.error ?? "", /never been observed|no rate_limit_event/);
});

test("ClaudeUsageMonitor: real captured 'allowed' rate_limit_event -> available, with real windows", async () => {
  const monitor = new ClaudeUsageMonitor(undefined, alwaysAvailableCli);
  for (const line of loadJsonl("claude-rate-limit-ok.jsonl")) monitor.observe(line);

  const status = await monitor.getStatus();
  assert.equal(status.classification, "available");
  assert.equal(status.primary?.usedPercent, 17);
  assert.equal(status.secondary?.usedPercent, 2);
  assert.equal(typeof status.observedAt, "number");
});

test("ClaudeUsageMonitor: mocked 'rejected' rate_limit_event -> exhausted", async () => {
  const monitor = new ClaudeUsageMonitor(undefined, alwaysAvailableCli);
  for (const line of loadJsonl("claude-rate-limit-exhausted.jsonl")) monitor.observe(line);

  const status = await monitor.getStatus();
  assert.equal(status.classification, "exhausted");
  assert.equal(status.primary?.usedPercent, 100);
});

test("ClaudeUsageMonitor: unparseable JSON, empty lines, and non-rate_limit_event lines are ignored, never thrown, and never observed", async () => {
  const monitor = new ClaudeUsageMonitor(undefined, alwaysAvailableCli);
  assert.doesNotThrow(() => {
    monitor.observeLine("not json at all {{{");
    monitor.observeLine("");
    monitor.observe(null);
    monitor.observe("a string, not an object");
    monitor.observe({ type: "assistant", message: { content: [] } }); // a real line type, just not the one we read
  });
  // None of those were a rate_limit_event, so this.last was never set.
  const status = await monitor.getStatus();
  assert.equal(status.classification, "unknown");
  assert.match(status.error ?? "", /no rate_limit_event/);
});

test("ClaudeUsageMonitor: a rate_limit_event with a missing/unrecognized status is observed but classifies as unknown (malformed payload, not ignored)", async () => {
  const monitor = new ClaudeUsageMonitor(undefined, alwaysAvailableCli);
  monitor.observe({ type: "rate_limit_event", rate_limit_info: {} }); // status field missing
  const status = await monitor.getStatus();
  assert.equal(status.classification, "unknown");
  assert.equal(typeof status.observedAt, "number"); // unlike "never observed", this WAS an observation
  assert.match(status.error ?? "", /unrecognized or missing/);
});

test("ClaudeUsageMonitor: a rate_limit_event with a recognizable status classifies even without window data", async () => {
  const monitor = new ClaudeUsageMonitor(undefined, alwaysAvailableCli);
  monitor.observe({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  const status = await monitor.getStatus();
  assert.equal(status.classification, "available");
  assert.equal(status.primary, null);
  assert.equal(status.secondary, null);
});

test("ClaudeUsageMonitor: claude CLI unavailable -> unknown with specific reason, independent of any observation", async () => {
  const monitor = new ClaudeUsageMonitor(undefined, () => Promise.resolve(false));
  monitor.observe({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });

  const status = await monitor.getStatus();
  assert.equal(status.classification, "unknown");
  assert.match(status.error ?? "", /not found on PATH/);
});

test("ClaudeUsageMonitor: stale observation -> unknown, not assumed still available", async () => {
  const monitor = new ClaudeUsageMonitor(10, alwaysAvailableCli); // 10ms staleness window
  monitor.observe({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1 } } } });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const status = await monitor.getStatus();
  assert.equal(status.classification, "unknown");
  assert.match(status.error ?? "", /stale/);
  // The stale snapshot's own numbers are still reported for context, just not trusted as current.
  assert.equal(status.primary?.usedPercent, 10);
});

test("ClaudeUsageMonitor.close: resolves without side effects", async () => {
  const monitor = new ClaudeUsageMonitor(undefined, alwaysAvailableCli);
  await assert.doesNotReject(() => monitor.close());
});
