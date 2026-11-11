import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateProviders, selectAlternativeProvider } from "../src/auto/providerSelection.js";
import type { SessionProvider } from "../src/sessions/types.js";
import type { UsageSnapshot } from "../src/usage/types.js";
import type { ProviderCooldown, UnknownAvailabilityPolicy } from "../src/auto/types.js";

const AVAILABLE: UsageSnapshot = { classification: "available", observedAt: Date.now(), primary: null, secondary: null };
const EXHAUSTED: UsageSnapshot = { classification: "exhausted", observedAt: Date.now(), primary: null, secondary: null };
const NO_UNKNOWN_POLICY: UnknownAvailabilityPolicy = { allow: false, maxAttempts: 0, cooldownMs: 0 };

function usageMap(map: Partial<Record<SessionProvider, UsageSnapshot>>): (p: SessionProvider) => Promise<UsageSnapshot> {
  return async (p) => map[p] ?? AVAILABLE;
}

test("candidateProviders: with 2 enabled providers, behaves exactly like the old otherProvider (single candidate)", () => {
  assert.deepEqual(candidateProviders("codex", ["codex", "claude"], null), ["claude"]);
  assert.deepEqual(candidateProviders("claude", ["codex", "claude"], null), ["codex"]);
});

test("candidateProviders: with 3+ enabled providers, returns every other one in enabled's own order", () => {
  assert.deepEqual(candidateProviders("codex", ["codex", "claude", "copilot"], null), ["claude", "copilot"]);
});

test("candidateProviders: a pinned provider collapses the list to just that one, or empty if it equals current", () => {
  assert.deepEqual(candidateProviders("codex", ["codex", "claude", "copilot"], "copilot"), ["copilot"]);
  assert.deepEqual(candidateProviders("codex", ["codex", "claude", "copilot"], "codex"), []);
});

test("selectAlternativeProvider: unchanged 2-provider behavior — no enabled list passed, defaults to [codex, claude]", async () => {
  const result = await selectAlternativeProvider("codex", null, usageMap({}), {}, NO_UNKNOWN_POLICY, {});
  assert.equal(result.decision, "select");
  assert.equal(result.provider, "claude");
});

test("selectAlternativeProvider: with 3 real enabled providers, a cooldown on the first candidate falls through to the next", async () => {
  const cooldowns: Partial<Record<SessionProvider, ProviderCooldown>> = {
    claude: { until: Date.now() + 60_000, reason: "on cooldown", fromReportedReset: false },
  };
  const result = await selectAlternativeProvider("codex", null, usageMap({ copilot: AVAILABLE }), cooldowns, NO_UNKNOWN_POLICY, {}, ["codex", "claude", "copilot"]);
  assert.equal(result.decision, "select");
  assert.equal(result.provider, "copilot");
});

test("selectAlternativeProvider: a genuinely fake 4th provider proves the fall-through loop isn't hardcoded to 2 or 3 candidates", async () => {
  const fake = "fake-fourth-provider" as SessionProvider;
  const cooldowns: Partial<Record<SessionProvider, ProviderCooldown>> = {
    claude: { until: Date.now() + 60_000, reason: "on cooldown", fromReportedReset: false },
  };
  const result = await selectAlternativeProvider("codex", null, usageMap({ copilot: EXHAUSTED, [fake]: AVAILABLE }), cooldowns, NO_UNKNOWN_POLICY, {}, ["codex", "claude", "copilot", fake]);
  assert.equal(result.decision, "select");
  assert.equal(result.provider, fake);
});

test("selectAlternativeProvider: pinned still forces a specific provider even among 3+ enabled", async () => {
  const result = await selectAlternativeProvider("codex", "copilot", usageMap({}), {}, NO_UNKNOWN_POLICY, {}, ["codex", "claude", "copilot"]);
  assert.equal(result.decision, "select");
  assert.equal(result.provider, "copilot");
});

test("selectAlternativeProvider: every enabled candidate blocked -> pause_exhausted reporting the last one checked", async () => {
  const result = await selectAlternativeProvider("codex", null, usageMap({ claude: EXHAUSTED, copilot: EXHAUSTED }), {}, NO_UNKNOWN_POLICY, {}, ["codex", "claude", "copilot"]);
  assert.equal(result.decision, "pause_exhausted");
  assert.equal(result.provider, "copilot");
});
