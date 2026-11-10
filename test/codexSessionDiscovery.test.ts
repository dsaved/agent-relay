import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverCodexSessions } from "../src/sessions/codexDiscovery.js";
import type { CodexAppServerTransport } from "../src/codex/appServerTransport.js";

class FakeTransport implements CodexAppServerTransport {
  closed = false;
  constructor(private readonly respond: (method: string, params: unknown) => unknown) {}
  async start(): Promise<void> {}
  async request<T>(method: string, params: unknown): Promise<T> {
    const result = this.respond(method, params);
    if (result instanceof Error) throw result;
    return result as T;
  }
  onNotification(): () => void {
    return () => {};
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

const SAMPLE_THREAD = {
  id: "0199-real",
  sessionId: "0199-real",
  cwd: "/tmp/codex-proj",
  status: { type: "notLoaded" },
  name: "Fix the widget",
  source: "vscode",
  originator: "Codex Desktop",
  updatedAt: 1700000000,
  recencyAt: 1700000500,
  gitInfo: { branch: "main", sha: "deadbeef", originUrl: "https://example.com/repo.git" },
};

test("discoverCodexSessions: happy path maps thread/list data, preserving source/originator and closing the transport", async () => {
  const transport = new FakeTransport((method) => {
    assert.equal(method, "thread/list");
    return { data: [SAMPLE_THREAD], nextCursor: null };
  });
  const result = await discoverCodexSessions(transport);

  assert.equal(result.error, undefined);
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.sessions[0], {
    provider: "codex",
    sessionId: "0199-real",
    projectDir: "/tmp/codex-proj",
    status: "notLoaded",
    lastActivity: 1700000500 * 1000,
    discoverySource: "codex-app-server:thread/list (vscode / Codex Desktop)",
    pid: null,
    title: "Fix the widget",
    providerGitInfo: { branch: "main", sha: "deadbeef", originUrl: "https://example.com/repo.git" },
  });
  assert.equal(transport.closed, true);
});

test("discoverCodexSessions: threads missing an id are skipped, not fatal", async () => {
  const transport = new FakeTransport(() => ({ data: [{ cwd: "/tmp/no-id" }, SAMPLE_THREAD] }));
  const result = await discoverCodexSessions(transport);
  assert.equal(result.sessions.length, 1);
});

test("discoverCodexSessions: malformed response (no `data` array) -> error, empty sessions", async () => {
  const transport = new FakeTransport(() => ({ oops: true }));
  const result = await discoverCodexSessions(transport);
  assert.equal(result.sessions.length, 0);
  assert.match(result.error ?? "", /no `data` array/);
});

test("discoverCodexSessions: transport/connection failure (e.g. codex CLI unavailable) -> error, never thrown, transport still closed", async () => {
  const transport = new FakeTransport(() => new Error("`codex` CLI was not found on PATH"));
  const result = await discoverCodexSessions(transport);
  assert.equal(result.sessions.length, 0);
  assert.match(result.error ?? "", /not found on PATH/);
  assert.equal(transport.closed, true);
});

test("discoverCodexSessions: duplicate thread entries are passed through as-is (deduping is associateSessions' job, not discovery's)", async () => {
  const transport = new FakeTransport(() => ({ data: [SAMPLE_THREAD, SAMPLE_THREAD] }));
  const result = await discoverCodexSessions(transport);
  assert.equal(result.sessions.length, 2);
});
