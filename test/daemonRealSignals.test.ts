import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pingDaemon } from "../src/daemon/client.js";
import { defaultSocketPath } from "../src/daemon/process.js";
import { withTempStoreRoot } from "./helpers/tempHandoffEnv.js";

const CLI_PATH = join(process.cwd(), "dist", "src", "cli.js");

async function waitForPing(socketPath: string, attempts = 40): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await pingDaemon(socketPath, 300)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 5_000): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Operational hardening: Phase 4's own coverage only exercised the
 * socket-level "shutdown" command and in-process `handle.stop()`, never
 * an actual OS signal delivered to a real, separately-spawned process —
 * this is the real thing, against a disposable `AGENT_RELAY_HOME` only.
 */
test("a real SIGTERM delivered to the daemon process exits it cleanly, socket stops answering", async () => {
  await withTempStoreRoot(async (stateDir) => {
    const child = spawn(process.execPath, [CLI_PATH, "daemon", "run-foreground"], { env: { ...process.env, AGENT_RELAY_HOME: stateDir }, stdio: "ignore" });
    try {
      const socketPath = defaultSocketPath(stateDir);
      assert.ok(await waitForPing(socketPath), "the real daemon process must come up and answer ping");

      child.kill("SIGTERM");
      const code = await waitForExit(child);
      assert.equal(code, 0, "a graceful SIGTERM shutdown must exit 0");
      assert.equal(await pingDaemon(socketPath, 500), null, "the socket must stop answering once the process has exited");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});

test("a real SIGINT delivered to the daemon process exits it cleanly too", async () => {
  await withTempStoreRoot(async (stateDir) => {
    const child = spawn(process.execPath, [CLI_PATH, "daemon", "run-foreground"], { env: { ...process.env, AGENT_RELAY_HOME: stateDir }, stdio: "ignore" });
    try {
      const socketPath = defaultSocketPath(stateDir);
      assert.ok(await waitForPing(socketPath), "the real daemon process must come up and answer ping");

      child.kill("SIGINT");
      const code = await waitForExit(child);
      assert.equal(code, 0);
      assert.equal(await pingDaemon(socketPath, 500), null);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
