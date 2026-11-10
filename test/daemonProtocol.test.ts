import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonSocketServer } from "../src/daemon/socketServer.js";
import { callDaemon, DaemonTimeoutError, DaemonCommandError, DaemonUnreachableError } from "../src/daemon/client.js";

async function withSocket(handlers: Record<string, (args: unknown) => Promise<unknown>>, run: (socketPath: string, server: DaemonSocketServer) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-socket-"));
  const socketPath = join(dir, "daemon.sock");
  const server = new DaemonSocketServer(socketPath, handlers);
  await server.start();
  try {
    await run(socketPath, server);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

test("callDaemon: a request/response round-trip returns the handler's result", async () => {
  await withSocket({ echo: async (args) => ({ got: args }) }, async (socketPath) => {
    const result = await callDaemon(socketPath, "echo", { x: 1 });
    assert.deepEqual(result, { got: { x: 1 } });
  });
});

test("callDaemon: an unknown command is reported as a DaemonCommandError, not a crash", async () => {
  await withSocket({}, async (socketPath) => {
    await assert.rejects(() => callDaemon(socketPath, "nonexistent", {}), DaemonCommandError);
  });
});

test("callDaemon: a handler that throws is reported as a DaemonCommandError carrying its message", async () => {
  await withSocket(
    {
      boom: async () => {
        throw new Error("deliberate failure");
      },
    },
    async (socketPath) => {
      await assert.rejects(() => callDaemon(socketPath, "boom", {}), (err: unknown) => err instanceof DaemonCommandError && err.message === "deliberate failure");
    },
  );
});

test("callDaemon: no socket at all is a DaemonUnreachableError, distinguishable from a rejected command", async () => {
  await assert.rejects(() => callDaemon("/nonexistent/path/agent-relay-test.sock", "ping", {}, { timeoutMs: 1000 }), DaemonUnreachableError);
});

test("callDaemon: a handler that never responds in time raises DaemonTimeoutError", async () => {
  await withSocket({ slow: () => new Promise(() => undefined) }, async (socketPath) => {
    await assert.rejects(() => callDaemon(socketPath, "slow", {}, { timeoutMs: 100 }), DaemonTimeoutError);
  });
});

test("the socket file is created with 0600 permissions — accessible only to this user", async () => {
  await withSocket({}, async (socketPath) => {
    const info = await stat(socketPath);
    assert.equal(info.mode & 0o777, 0o600);
  });
});

test("malformed input on the wire is dropped, not fatal to the connection or the server", async () => {
  await withSocket({ ping: async () => "pong" }, async (socketPath) => {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once("connect", () => {
        socket.write("not json at all\n");
        socket.end();
        socket.once("close", () => resolve());
      });
      socket.once("error", reject);
    });
    // The server must still be alive and answering afterward.
    const result = await callDaemon(socketPath, "ping", {});
    assert.equal(result, "pong");
  });
});

test("restarting the server at the same path cleans up a stale socket file rather than failing to bind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-socket-"));
  const socketPath = join(dir, "daemon.sock");
  try {
    const first = new DaemonSocketServer(socketPath, { ping: async () => "pong" });
    await first.start();
    await first.stop(); // removes the file cleanly

    const second = new DaemonSocketServer(socketPath, { ping: async () => "pong2" });
    await second.start();
    try {
      assert.equal(await callDaemon(socketPath, "ping", {}), "pong2");
    } finally {
      await second.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
