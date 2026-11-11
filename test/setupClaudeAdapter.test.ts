import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter, HOOK_MARKER, MANAGED_HOOK_EVENTS, buildHookCommand } from "../src/setup/claudeCodeAdapter.js";

const INSTALLED = async () => ({ installed: true, version: "2.1.0" });
const EVENT_COUNT = MANAGED_HOOK_EVENTS.length;

async function withFakeHome(run: (settingsPath: string, lockDir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-claude-settings-"));
  try {
    await run(join(dir, "settings.json"), join(dir, "locks"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function adapter(settingsPath: string, lockDir: string, nodePath = "/usr/bin/node", cliPath = "/opt/agent-relay/cli.js") {
  return new ClaudeCodeAdapter({ settingsPath, lockDir, nodePath, cliPath, checkCliAvailable: INSTALLED });
}

test("plan(): a missing settings file proposes adding one hook per managed event, nothing more", async () => {
  await withFakeHome(async (settingsPath, lockDir) => {
    const changes = await adapter(settingsPath, lockDir).plan();
    assert.equal(changes.length, EVENT_COUNT);
    for (const c of changes) assert.equal(c.kind, "add_hook");
    assert.ok(changes.some((c) => c.description.includes("Stop hook")));
  });
});

test("apply(): creates the file, writes every managed hook, and the generated command uses absolute paths", async () => {
  await withFakeHome(async (settingsPath, lockDir) => {
    const result = await adapter(settingsPath, lockDir).apply();
    assert.equal(result.applied.length, EVENT_COUNT);
    assert.deepEqual(result.backupPaths, []); // nothing existed yet, so there's nothing to back up

    const written = JSON.parse(await readFile(settingsPath, "utf8"));
    for (const event of MANAGED_HOOK_EVENTS) {
      const command = written.hooks[event][0].hooks[0].command;
      assert.equal(command, buildHookCommand("/usr/bin/node", "/opt/agent-relay/cli.js"));
      assert.match(command, /^"\/usr\/bin\/node" "\/opt\/agent-relay\/cli\.js" desktop hook-event$/);
      assert.ok(command.includes(HOOK_MARKER));
      assert.equal(written.hooks[event][0].hooks[0].timeout, 5);
    }
  });
});

test("apply(): preserves every unrelated hook and setting byte-for-byte, only adding our own entries", async () => {
  await withFakeHome(async (settingsPath, lockDir) => {
    const existing = {
      model: "some-model",
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo unrelated-stop-hook" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "echo session-start" }] }],
      },
    };
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(existing, null, 2));

    await adapter(settingsPath, lockDir).apply();

    const written = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(written.model, "some-model");
    assert.deepEqual(written.permissions, { allow: ["Bash(ls:*)"] });
    assert.deepEqual(written.hooks.SessionStart, existing.hooks.SessionStart);
    assert.equal(written.hooks.Stop.length, 2, "the unrelated Stop hook survives alongside our new one");
    assert.equal(written.hooks.Stop[0].hooks[0].command, "echo unrelated-stop-hook");
    assert.match(written.hooks.Stop[1].hooks[0].command, new RegExp(HOOK_MARKER));
    assert.equal(written.hooks.SessionEnd.length, 1, "SessionEnd gets its own new entry too");
  });
});

test("apply(): backs up the previous file before writing, and the backup matches the original exactly", async () => {
  await withFakeHome(async (settingsPath, lockDir) => {
    const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo original" }] }] } };
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(original, null, 2));

    const result = await adapter(settingsPath, lockDir).apply();
    assert.equal(result.backupPaths.length, 1);
    assert.match(result.backupPaths[0]!, /\.bak-/);
    const backedUp = JSON.parse(await readFile(result.backupPaths[0]!, "utf8"));
    assert.deepEqual(backedUp, original);
  });
});

test("apply(): preserves the original file's permission mode", async () => {
  await withFakeHome(async (settingsPath, lockDir) => {
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({}));
    await chmod(settingsPath, 0o640);

    await adapter(settingsPath, lockDir).apply();
    const info = await stat(settingsPath);
    assert.equal(info.mode & 0o777, 0o640);
  });
});

test("idempotency: apply() twice never creates a duplicate hook entry", async () => {
  await withFakeHome(async (settingsPath, lockDir) => {
    const a = adapter(settingsPath, lockDir);
    const first = await a.apply();
    assert.equal(first.noopAlreadyUpToDate, false);
    const second = await a.apply();
    assert.equal(second.noopAlreadyUpToDate, true);
    assert.deepEqual(second.backupPaths, []);

    const written = JSON.parse(await readFile(settingsPath, "utf8"));
    for (const event of MANAGED_HOOK_EVENTS) assert.equal(written.hooks[event].length, 1, `running apply() twice must not duplicate the ${event} hook`);
  });
});

test("concurrency: two apply() calls racing on the same file never duplicate the hook", async () => {
  await withFakeHome(async (settingsPath, lockDir) => {
    const a = adapter(settingsPath, lockDir);
    const b = adapter(settingsPath, lockDir);
    await Promise.all([a.apply(), b.apply()]);

    const written = JSON.parse(await readFile(settingsPath, "utf8"));
    for (const event of MANAGED_HOOK_EVENTS) assert.equal(written.hooks[event].length, 1, `a concurrent race must not duplicate the ${event} hook`);
  });
});

test("idempotency: plan() after apply() reports nothing left to do", async () => {
  await withFakeHome(async (settingsPath, lockDir) => {
    const a = adapter(settingsPath, lockDir);
    await a.apply();
    assert.deepEqual(await a.plan(), []);
  });
});

test("a corrupted existing settings file is refused, never silently overwritten", async () => {
  await withFakeHome(async (settingsPath, lockDir) => {
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(settingsPath, "{not json at all");
    await assert.rejects(() => adapter(settingsPath, lockDir).plan(), /not valid JSON/);
    await assert.rejects(() => adapter(settingsPath, lockDir).apply(), /not valid JSON/);
    // The file on disk must be untouched — still exactly the corrupted content, not replaced with an empty-based guess.
    assert.equal(await readFile(settingsPath, "utf8"), "{not json at all");
  });
});

test("status(): missing -> 'missing', installed -> 'installed', then a deleted executable -> 'broken', for every managed event", async () => {
  await withFakeHome(async (settingsPath, lockDir) => {
    const dir = await mkdtemp(join(tmpdir(), "agent-relay-fake-bin-"));
    try {
      const fakeNode = join(dir, "node");
      await writeFile(fakeNode, "#!/bin/sh\n");
      await chmod(fakeNode, 0o755);
      const a = adapter(settingsPath, lockDir, fakeNode, join(dir, "cli.js"));

      const missing = await a.status();
      assert.equal(missing.entries.length, EVENT_COUNT);
      for (const e of missing.entries) assert.equal(e.status, "missing");

      await a.apply();
      const installed = await a.status();
      for (const e of installed.entries) assert.equal(e.status, "installed");

      await rm(fakeNode);
      const broken = await a.status();
      for (const e of broken.entries) assert.equal(e.status, "broken");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("uninstall(): removes only our own hook entries, leaves unrelated ones and a no-hooks-at-all case alone", async () => {
  await withFakeHome(async (settingsPath, lockDir) => {
    const a = adapter(settingsPath, lockDir);

    // Nothing installed yet — uninstall is a clean no-op.
    const noop = await a.uninstall();
    assert.equal(noop.noopAlreadyUpToDate, true);

    const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo unrelated" }] }] } };
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(existing));
    await a.apply();

    const result = await a.uninstall();
    assert.equal(result.applied.length, EVENT_COUNT);
    assert.equal(result.backupPaths.length, 1);

    const written = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(written.hooks.Stop.length, 1);
    assert.equal(written.hooks.Stop[0].hooks[0].command, "echo unrelated");
    assert.equal(written.hooks.SessionEnd.length, 0);
  });
});

test("repair(): a 'missing' status is fixed by repair(), and repair() on an already-installed hook is a no-op", async () => {
  await withFakeHome(async (settingsPath, lockDir) => {
    const dir = await mkdtemp(join(tmpdir(), "agent-relay-fake-bin-"));
    try {
      const fakeNode = join(dir, "node");
      await writeFile(fakeNode, "#!/bin/sh\n");
      await chmod(fakeNode, 0o755);
      const a = adapter(settingsPath, lockDir, fakeNode, join(dir, "cli.js"));

      const repaired = await a.repair();
      assert.equal(repaired.noopAlreadyUpToDate, false);
      for (const e of (await a.status()).entries) assert.equal(e.status, "installed");

      const again = await a.repair();
      assert.equal(again.noopAlreadyUpToDate, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
