import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHookEvent, DesktopRegistry } from "../src/desktop/registry.js";
import { HandoffStore } from "../src/handoff/store.js";
import type { SessionAssociation } from "../src/sessions/types.js";
import type { DiscoverAllResult } from "../src/sessions/discoverAll.js";
import { withTempRepo } from "./helpers/tempGitRepo.js";
import { withTempStoreRoot, makeSessionAssociation } from "./helpers/tempHandoffEnv.js";
import { CONFIRMED_IDLE } from "./helpers/autoTestEnv.js";

test("parseHookEvent: a well-formed Claude Code hook payload parses cleanly", () => {
  const result = parseHookEvent(JSON.stringify({ session_id: "s-1", hook_event_name: "Stop", cwd: "/tmp/x" }));
  assert.ok("payload" in result);
  if ("payload" in result) {
    assert.equal(result.payload.session_id, "s-1");
    assert.equal(result.payload.hook_event_name, "Stop");
  }
});

test("parseHookEvent: invalid JSON is reported, never thrown", () => {
  const result = parseHookEvent("{not json");
  assert.deepEqual(result, { error: "hook-event input was not valid JSON" });
});

test("parseHookEvent: missing session_id or hook_event_name is reported, never thrown", () => {
  assert.deepEqual(parseHookEvent(JSON.stringify({ hook_event_name: "Stop" })), { error: "hook-event input is missing a string `session_id`" });
  assert.deepEqual(parseHookEvent(JSON.stringify({ session_id: "s-1" })), { error: "hook-event input is missing a string `hook_event_name`" });
  assert.deepEqual(parseHookEvent(JSON.stringify(["not", "an", "object"])), { error: "hook-event input was not a JSON object" });
});

test("a parsed hook event feeds the registry's evidence trail for an already-registered session", async () => {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      const store = new HandoffStore(storeRoot);
      const session = makeSessionAssociation({ sessionId: "desk-hook-1", provider: "claude", repoRoot, workspaceAccessible: true, title: "Task" });
      const discover = async (): Promise<DiscoverAllResult> => ({ sessions: [session] as SessionAssociation[], errors: [] });
      const registry = new DesktopRegistry({ store, discover, checkProviderActivity: async () => CONFIRMED_IDLE });
      await registry.register("desk-hook-1");

      const parsed = parseHookEvent(JSON.stringify({ session_id: "desk-hook-1", hook_event_name: "SessionStart" }));
      assert.ok("payload" in parsed);
      if ("payload" in parsed) {
        const updated = await registry.recordEvidence("desk-hook-1", `claude-code-hook:${parsed.payload.hook_event_name}`, JSON.stringify(parsed.payload));
        assert.match(updated!.evidence.at(-1)!.source, /SessionStart/);
      }
    });
  });
});
