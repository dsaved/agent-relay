import { test } from "node:test";
import assert from "node:assert/strict";
import { startDaemon } from "../src/daemon/process.js";
import { callDaemon, pingDaemon, DaemonUnreachableError } from "../src/daemon/client.js";
import { withTempStoreRoot } from "./helpers/tempHandoffEnv.js";

test("startDaemon: ping reports pid/uptime for a freshly started daemon", async () => {
  await withTempStoreRoot(async (stateDir) => {
    const handle = await startDaemon({ stateDir });
    try {
      const ping = await pingDaemon(handle.socketPath);
      assert.ok(ping);
      assert.equal(ping!.pid, process.pid);
      assert.ok(ping!.uptimeMs >= 0);
    } finally {
      await handle.stop();
    }
  });
});

test("single-instance enforcement: a second daemon refuses to start against the same state directory", async () => {
  await withTempStoreRoot(async (stateDir) => {
    const first = await startDaemon({ stateDir });
    try {
      await assert.rejects(() => startDaemon({ stateDir }), /already running/);
    } finally {
      await first.stop();
    }
  });
});

test("after stop(), the socket no longer answers — a later start against the same directory succeeds", async () => {
  await withTempStoreRoot(async (stateDir) => {
    const first = await startDaemon({ stateDir });
    await first.stop();
    await assert.rejects(() => callDaemon(first.socketPath, "ping", {}, { timeoutMs: 500 }), DaemonUnreachableError);

    const second = await startDaemon({ stateDir });
    try {
      assert.ok(await pingDaemon(second.socketPath));
    } finally {
      await second.stop();
    }
  });
});

test("multiple CLI clients can each round-trip against the same running daemon", async () => {
  await withTempStoreRoot(async (stateDir) => {
    const handle = await startDaemon({ stateDir });
    try {
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => callDaemon(handle.socketPath, "ping", {})));
      assert.equal(results.length, 5);
      for (const r of results) assert.equal((r as { pid: number }).pid, process.pid);
    } finally {
      await handle.stop();
    }
  });
});

test("the 'shutdown' command gracefully stops the daemon after acknowledging the request", async () => {
  await withTempStoreRoot(async (stateDir) => {
    const handle = await startDaemon({ stateDir });
    const ack = await callDaemon(handle.socketPath, "shutdown", {});
    assert.deepEqual(ack, { acknowledged: true });
    // Give the fire-and-forget cleanup a moment to actually run.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await pingDaemon(handle.socketPath, 500), null);
  });
});

test("stop() is idempotent — calling it twice never throws", async () => {
  await withTempStoreRoot(async (stateDir) => {
    const handle = await startDaemon({ stateDir });
    await handle.stop();
    await handle.stop();
  });
});

/**
 * Operational-hardening fix #2: a genuine race (not just sequential
 * start-then-start, which Phase 4 already covered) between two
 * processes trying to start a daemon for the same state directory.
 * Exactly one must win; the other must refuse, and there must never be
 * two live daemons answering the same socket afterward.
 */
test("daemon single-instance race: two concurrent starts for the same state directory — exactly one wins", async () => {
  await withTempStoreRoot(async (stateDir) => {
    const results = await Promise.allSettled([startDaemon({ stateDir }), startDaemon({ stateDir })]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one concurrent start must succeed");
    assert.equal(rejected.length, 1, "the other must refuse, never silently coexist");

    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof startDaemon>>>).value;
    const ping = await pingDaemon(winner.socketPath);
    assert.ok(ping, "the winning daemon must actually be reachable afterward");
    await winner.stop();
  });
});
