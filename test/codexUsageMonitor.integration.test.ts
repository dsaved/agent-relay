import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexUsageMonitor } from "../src/codex/usageMonitor.js";
import { formatCodexUsageStatus } from "../src/codex/formatUsage.js";

/**
 * Live integration check against the real `codex app-server`. This issues
 * exactly one request — `account/rateLimits/read` — and nothing else: no
 * `exec`, no turn, no model prompt, no tokens spent. It is safe to run on
 * every `npm test`, including against an account that is fully exhausted
 * (the case it was written against — see docs/FEASIBILITY.md Phase 1A).
 *
 * The assertion is deliberately loose on *which* of the three outcomes we
 * get, since that depends on the real, time-varying state of whatever
 * account runs this — asserting "exhausted" would make the test flaky the
 * moment the account's usage window resets. What's actually being verified
 * is that the monitor completes, classifies into one of the three defined
 * buckets, and never throws — i.e. requirement #10 (handle failures
 * without crashing) holds against the real binary, not just mocks.
 */
test("CodexUsageMonitor (live): account/rateLimits/read completes without a model prompt and classifies cleanly", async () => {
  const monitor = new CodexUsageMonitor();
  try {
    const status = await monitor.getStatus();
    console.log("Live Codex usage check:\n" + formatCodexUsageStatus(status));

    assert.ok(["available", "exhausted", "unknown"].includes(status.classification));
    if (status.classification === "unknown") {
      // Only acceptable if it's a *handled* failure (missing codex binary, auth
      // issue, protocol error) — i.e. it has a human-readable reason, not a
      // silently empty result.
      assert.equal(typeof status.error, "string");
    } else {
      // A definitive answer must come with the structured fields it's based on.
      assert.equal(typeof status.ordinaryUsageAllowed, "boolean");
    }
  } finally {
    await monitor.close();
  }
});
