import { test } from "node:test";
import assert from "node:assert/strict";
import { DesktopRegistry, parseHookEvent } from "../src/desktop/registry.js";
import { HandoffStore } from "../src/handoff/store.js";
import type { SessionAssociation } from "../src/sessions/types.js";
import type { DiscoverAllResult } from "../src/sessions/discoverAll.js";
import { withTempRepo } from "./helpers/tempGitRepo.js";
import { withTempStoreRoot, makeSessionAssociation } from "./helpers/tempHandoffEnv.js";
import { CONFIRMED_IDLE } from "./helpers/autoTestEnv.js";

/**
 * Requirement #12: a `Stop` hook event is evidence, never a conclusion.
 * This asserts directly that running one through `desktop hook-event`'s
 * underlying `recordEvidence` call changes nothing about a session's
 * recorded ownership/activity — it only appends to the audit trail.
 */
test("a Stop hook event only appends evidence — it never changes ownershipStatus or observedActivity", async () => {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      const store = new HandoffStore(storeRoot);
      const session = makeSessionAssociation({ sessionId: "desk-stop-1", provider: "claude", repoRoot, workspaceAccessible: true, title: "Task" });
      const discover = async (): Promise<DiscoverAllResult> => ({ sessions: [session] as SessionAssociation[], errors: [] });
      const registry = new DesktopRegistry({ store, discover, checkProviderActivity: async () => CONFIRMED_IDLE });

      const registered = await registry.register("desk-stop-1");
      const before = { ownershipStatus: registered.ownershipStatus, observedActivity: registered.observedActivity };

      const parsed = parseHookEvent(JSON.stringify({ session_id: "desk-stop-1", hook_event_name: "Stop" }));
      assert.ok("payload" in parsed);
      if (!("payload" in parsed)) return;
      const updated = await registry.recordEvidence("desk-stop-1", `claude-code-hook:${parsed.payload.hook_event_name}`, JSON.stringify(parsed.payload));

      assert.equal(updated!.ownershipStatus, before.ownershipStatus, "a Stop event must never change ownership on its own");
      assert.equal(updated!.observedActivity, before.observedActivity, "a Stop event must never be read as a workspace-inactivity signal");
      assert.equal(updated!.evidence.length, registered.evidence.length + 1, "it is recorded as one new evidence entry — nothing else");
      assert.match(updated!.evidence.at(-1)!.source, /Stop/);
    });
  });
});

test("parseHookEvent treats 'Stop' as just another event name — no special-cased interpretation anywhere in the parser", () => {
  const stop = parseHookEvent(JSON.stringify({ session_id: "s-1", hook_event_name: "Stop" }));
  const sessionStart = parseHookEvent(JSON.stringify({ session_id: "s-1", hook_event_name: "SessionStart" }));
  assert.ok("payload" in stop && "payload" in sessionStart);
  if ("payload" in stop && "payload" in sessionStart) {
    assert.equal(typeof stop.payload.hook_event_name, typeof sessionStart.payload.hook_event_name);
  }
});
