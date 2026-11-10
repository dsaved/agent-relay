import { test } from "node:test";
import assert from "node:assert/strict";
import { assessDesktopOwnership, type DesktopOwnershipInput } from "../src/desktop/ownership.js";
import type { ProviderActivitySignal } from "../src/handoff/lock.js";

const IDLE: ProviderActivitySignal = { status: "confirmed_idle", reason: "no running session found for this workspace" };
const BUSY: ProviderActivitySignal = { status: "confirmed_busy", reason: "a session is reported busy for this workspace" };
const UNKNOWN: ProviderActivitySignal = { status: "unknown", reason: "liveness cannot be confirmed for this workspace" };

function input(overrides: Partial<DesktopOwnershipInput>): DesktopOwnershipInput {
  return { priorState: null, heldByThisProcess: false, activitySignal: IDLE, handoffAuthorizedNow: false, sourceProcessGroupTerminated: false, ...overrides };
}

test("holding the lock ourselves is always relay_owned, regardless of prior state or activity", () => {
  const a = assessDesktopOwnership(input({ heldByThisProcess: true, activitySignal: BUSY, priorState: "external_active" }));
  assert.equal(a.state, "relay_owned");
  assert.equal(a.canTakeOwnership, true);
});

test("never registered, idle -> external_unmanaged", () => {
  const a = assessDesktopOwnership(input({ activitySignal: IDLE }));
  assert.equal(a.state, "external_unmanaged");
  assert.equal(a.canTakeOwnership, false);
});

test("never registered, confirmed busy -> external_active", () => {
  const a = assessDesktopOwnership(input({ activitySignal: BUSY }));
  assert.equal(a.state, "external_active");
  assert.equal(a.canTakeOwnership, false);
});

test("never registered, unknown liveness -> external_unknown (e.g. ordinary Codex thread history)", () => {
  const a = assessDesktopOwnership(input({ activitySignal: UNKNOWN }));
  assert.equal(a.state, "external_unknown");
  assert.equal(a.canTakeOwnership, false);
});

test("authorized now + source confirmed idle -> handoff_requested, canTakeOwnership true", () => {
  const a = assessDesktopOwnership(input({ handoffAuthorizedNow: true, activitySignal: IDLE }));
  assert.equal(a.state, "handoff_requested");
  assert.equal(a.canTakeOwnership, true);
});

test("authorized now + source confirmed busy -> handoff_requested, but canTakeOwnership false (never escalates on its own)", () => {
  const a = assessDesktopOwnership(input({ handoffAuthorizedNow: true, activitySignal: BUSY }));
  assert.equal(a.state, "handoff_requested");
  assert.equal(a.canTakeOwnership, false);
});

test("authorized now + source was a Relay worker whose process group terminated -> canTakeOwnership true even if the fresh activity check itself is unknown", () => {
  const a = assessDesktopOwnership(input({ handoffAuthorizedNow: true, activitySignal: UNKNOWN, sourceProcessGroupTerminated: true }));
  assert.equal(a.state, "handoff_requested");
  assert.equal(a.canTakeOwnership, true);
  assert.match(a.reason, /process group has terminated/);
});

test("a PAST handoff_requested authorization is never reused as standing permission on a later, non-authorizing call", () => {
  const stillBusy = assessDesktopOwnership(input({ priorState: "handoff_requested", handoffAuthorizedNow: false, activitySignal: BUSY }));
  assert.equal(stillBusy.state, "handoff_requested");
  assert.equal(stillBusy.canTakeOwnership, false, "busy now must never be overridden by an old authorization");

  const nowIdle = assessDesktopOwnership(input({ priorState: "handoff_requested", handoffAuthorizedNow: false, activitySignal: IDLE }));
  assert.equal(nowIdle.state, "handoff_requested");
  assert.equal(nowIdle.canTakeOwnership, false, "evidence alone, without a fresh explicit authorization call, is reported but never silently acted on");
});

test("previously relay_owned, lock lost, new external activity confirmed busy -> relinquished, not silently external_active", () => {
  const a = assessDesktopOwnership(input({ priorState: "relay_owned", heldByThisProcess: false, activitySignal: BUSY }));
  assert.equal(a.state, "relinquished");
  assert.equal(a.canTakeOwnership, false);
});

test("--force-lock is not a concept this pure function knows about — it only ever reports real evidence", () => {
  const a = assessDesktopOwnership(input({ activitySignal: BUSY }));
  assert.equal("forceLockOverride" in a, false);
});
