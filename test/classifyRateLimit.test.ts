import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyRateLimit } from "../src/classifyRateLimit.js";

// npm scripts always run this from the package root, so fixtures/ (never
// compiled, so it can't sit next to the .js this runs as) resolves off cwd.
const fixturesDir = join(process.cwd(), "fixtures");

function loadJsonl(name: string): unknown[] {
  return readFileSync(join(fixturesDir, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

test("codex: real captured usage-limit output classifies as exhausted", () => {
  const lines = loadJsonl("codex-usage-limit.jsonl");
  const status = classifyRateLimit("codex", lines);
  assert.equal(status.classification, "exhausted");
  assert.match(status.rawMessage ?? "", /usage limit/i);
});

test("codex: documented agent_message success shape classifies as unknown (no structured rate-limit field)", () => {
  const lines = loadJsonl("codex-success.jsonl");
  const status = classifyRateLimit("codex", lines);
  assert.equal(status.classification, "unknown");
});

test("claude: real captured output with status=allowed classifies as ok with window percentages", () => {
  const lines = loadJsonl("claude-rate-limit-ok.jsonl");
  const status = classifyRateLimit("claude", lines);
  assert.equal(status.classification, "ok");
  assert.equal(status.primary?.usedPercent, 17);
  assert.equal(status.secondary?.usedPercent, 2);
});

test("claude: mocked status=rejected output classifies as exhausted", () => {
  const lines = loadJsonl("claude-rate-limit-exhausted.jsonl");
  const status = classifyRateLimit("claude", lines);
  assert.equal(status.classification, "exhausted");
  assert.equal(status.primary?.usedPercent, 100);
});

test("unrelated lines do not affect classification", () => {
  const status = classifyRateLimit("codex", [{ type: "thread.started", thread_id: "x" }]);
  assert.equal(status.classification, "unknown");
});
