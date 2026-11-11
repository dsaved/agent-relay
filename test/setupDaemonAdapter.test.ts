import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonLaunchdAdapter } from "../src/setup/daemonAdapter.js";

interface Ctx {
  plistFilePath: string;
  lockDir: string;
  stateDir: string;
  cliPath: string;
}

async function withFakeHome(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-plist-"));
  try {
    const cliPath = join(dir, "cli.js");
    await writeFile(cliPath, "// fake cli.js for status()'s executable-existence check\n");
    await run({ plistFilePath: join(dir, "LaunchAgents", "com.agent-relay.daemon.plist"), lockDir: join(dir, "locks"), stateDir: join(dir, "state"), cliPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function adapter(ctx: Ctx, overrides: { platform?: NodeJS.Platform; cliPath?: string } = {}) {
  return new DaemonLaunchdAdapter({
    plistFilePath: ctx.plistFilePath,
    lockDir: ctx.lockDir,
    stateDir: ctx.stateDir,
    nodePath: "/usr/bin/node",
    cliPath: overrides.cliPath ?? ctx.cliPath,
    platform: overrides.platform ?? "darwin",
  });
}

test("detect(): not_applicable off macOS, applicable on macOS", async () => {
  await withFakeHome(async (ctx) => {
    assert.equal((await adapter(ctx, { platform: "darwin" }).detect()).installed, true);
    const linuxDetection = await adapter(ctx, { platform: "linux" }).detect();
    assert.equal(linuxDetection.installed, false);
    assert.match(linuxDetection.detail, /not macOS/);
  });
});

test("plan()/apply(): writes the plist when missing, then reports nothing left to do", async () => {
  await withFakeHome(async (ctx) => {
    const a = adapter(ctx);
    assert.equal((await a.plan()).length, 1);

    const result = await a.apply();
    assert.equal(result.applied.length, 1);
    assert.deepEqual(result.backupPaths, []);
    const content = await readFile(ctx.plistFilePath, "utf8");
    assert.match(content, /run-foreground/);

    assert.deepEqual(await a.plan(), []);
    const second = await a.apply();
    assert.equal(second.noopAlreadyUpToDate, true);
  });
});

test("status(): missing -> installed -> broken when the content drifts from what this build generates", async () => {
  await withFakeHome(async (ctx) => {
    const a = adapter(ctx);
    assert.equal((await a.status()).entries[0]!.status, "missing");

    await a.apply();
    assert.equal((await a.status()).entries[0]!.status, "installed");

    // A different build (a different cliPath that doesn't exist) now considers the existing file stale/broken.
    const changedCliPath = adapter(ctx, { cliPath: join(ctx.stateDir, "..", "newer-cli.js") });
    assert.equal((await changedCliPath.status()).entries[0]!.status, "broken");
  });
});

test("uninstall(): backs up and removes the plist; a clean uninstall on a missing file is a no-op", async () => {
  await withFakeHome(async (ctx) => {
    const a = adapter(ctx);
    const noop = await a.uninstall();
    assert.equal(noop.noopAlreadyUpToDate, true);

    await a.apply();
    const result = await a.uninstall();
    assert.equal(result.applied.length, 1);
    assert.equal(result.backupPaths.length, 1);
    await assert.rejects(() => readFile(ctx.plistFilePath, "utf8"));
    const backup = await readFile(result.backupPaths[0]!, "utf8");
    assert.match(backup, /run-foreground/);
  });
});
