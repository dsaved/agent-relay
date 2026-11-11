import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, validateConfig } from "../src/daemon/config.js";

test("validateConfig: the default config has no problems", () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
});

test("validateConfig: catches an unknown provider, a non-positive limit, and a bad log level all at once", () => {
  const problems = validateConfig({
    ...DEFAULT_CONFIG,
    enabledProviders: ["codex", "gemini" as never],
    maxConcurrentTasks: 0,
    logLevel: "verbose" as never,
  });
  assert.ok(problems.some((p) => p.includes("enabledProviders")));
  assert.ok(problems.some((p) => p.includes("maxConcurrentTasks")));
  assert.ok(problems.some((p) => p.includes("logLevel")));
});

test("validateConfig: 'copilot' is accepted as a known provider, for both enabledProviders and preferredStartingProvider", () => {
  assert.deepEqual(validateConfig({ ...DEFAULT_CONFIG, enabledProviders: ["codex", "claude", "copilot"], preferredStartingProvider: "copilot" }), []);
});

test("validateConfig: preferredStartingProvider outside enabledProviders' known set is flagged", () => {
  const problems = validateConfig({ ...DEFAULT_CONFIG, preferredStartingProvider: "gemini" as never });
  assert.ok(problems.some((p) => p.includes("preferredStartingProvider")));
});

test("validateConfig: a malformed unknownAvailabilityPolicy is flagged, never crashes", () => {
  const problems = validateConfig({ ...DEFAULT_CONFIG, unknownAvailabilityPolicy: { allow: "yes" as never, maxAttempts: -1, cooldownMs: 10 } });
  assert.ok(problems.some((p) => p.includes("unknownAvailabilityPolicy")));
});

test("validateConfig: never crashes on a config with nothing wrong except one bad field, type coercion never applied", () => {
  const problems = validateConfig({ ...DEFAULT_CONFIG, logRetentionDays: -5 });
  assert.deepEqual(problems, ["logRetentionDays must be a non-negative number"]);
});
