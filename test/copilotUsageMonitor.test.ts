import { test } from "node:test";
import assert from "node:assert/strict";
import { CopilotUsageMonitor, classifyCopilotLine } from "../src/copilot/usageMonitor.js";

function alwaysAvailableCli() {
  return Promise.resolve(true);
}

test("CopilotUsageMonitor: no observation yet -> unknown, never guesses available", async () => {
  const monitor = new CopilotUsageMonitor(undefined, alwaysAvailableCli);
  const status = await monitor.getStatus();
  assert.equal(status.classification, "unknown");
  assert.equal(status.observedAt, null);
  assert.match(status.error ?? "", /no usage signal/);
});

test("classifyCopilotLine: a message field matching the quota pattern classifies as exhausted", () => {
  assert.equal(classifyCopilotLine({ message: "You have exceeded your premium request quota" }), "exhausted");
  assert.equal(classifyCopilotLine({ text: "rate limit reached" }), "exhausted");
  assert.equal(classifyCopilotLine({ result: "ai credit usage limit hit" }), "exhausted");
});

test("classifyCopilotLine: a message field present but not matching the pattern classifies as unknown, not ignored", () => {
  assert.equal(classifyCopilotLine({ message: "task completed successfully" }), "unknown");
});

test("classifyCopilotLine: no message/text/result string field at all -> null (not observed)", () => {
  assert.equal(classifyCopilotLine({ type: "assistant", other: 1 }), null);
  assert.equal(classifyCopilotLine(null), null);
  assert.equal(classifyCopilotLine("a string, not an object"), null);
});

test("CopilotUsageMonitor: an exhausted-classified line -> exhausted status", async () => {
  const monitor = new CopilotUsageMonitor(undefined, alwaysAvailableCli);
  monitor.observe({ message: "premium request quota exceeded" });
  const status = await monitor.getStatus();
  assert.equal(status.classification, "exhausted");
  assert.equal(typeof status.observedAt, "number");
});

test("CopilotUsageMonitor.observeLine: unparseable JSON and empty lines are ignored, never thrown", async () => {
  const monitor = new CopilotUsageMonitor(undefined, alwaysAvailableCli);
  assert.doesNotThrow(() => {
    monitor.observeLine("not json at all {{{");
    monitor.observeLine("");
  });
  const status = await monitor.getStatus();
  assert.equal(status.classification, "unknown");
  assert.equal(status.observedAt, null);
});

test("CopilotUsageMonitor: copilot CLI unavailable -> unknown with specific reason, independent of any observation", async () => {
  const monitor = new CopilotUsageMonitor(undefined, () => Promise.resolve(false));
  monitor.observe({ message: "quota exceeded" });
  const status = await monitor.getStatus();
  assert.equal(status.classification, "unknown");
  assert.match(status.error ?? "", /not found on PATH/);
});

test("CopilotUsageMonitor: stale observation -> unknown, not assumed still current", async () => {
  const monitor = new CopilotUsageMonitor(10, alwaysAvailableCli); // 10ms staleness window
  monitor.observe({ message: "quota exceeded" });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const status = await monitor.getStatus();
  assert.equal(status.classification, "unknown");
  assert.match(status.error ?? "", /stale/);
});

test("CopilotUsageMonitor: never reports primary/secondary usage windows — no confirmed structured shape exists", async () => {
  const monitor = new CopilotUsageMonitor(undefined, alwaysAvailableCli);
  monitor.observe({ message: "ok" });
  const status = await monitor.getStatus();
  assert.equal(status.primary, null);
  assert.equal(status.secondary, null);
});

test("CopilotUsageMonitor.close: resolves without side effects", async () => {
  const monitor = new CopilotUsageMonitor(undefined, alwaysAvailableCli);
  await assert.doesNotReject(() => monitor.close());
});
