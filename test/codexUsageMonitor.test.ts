import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAccountRateLimits, CodexUsageMonitor } from "../src/codex/usageMonitor.js";
import type { CodexAppServerTransport } from "../src/codex/appServerTransport.js";

const fixturesDir = join(process.cwd(), "fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

test("classifyAccountRateLimits: real exhausted response -> exhausted, with real windows", () => {
  const status = classifyAccountRateLimits(loadFixture("codex-account-rate-limits-exhausted.json"));
  assert.equal(status.classification, "exhausted");
  assert.equal(status.rateLimitReachedType, "rate_limit_reached");
  assert.equal(status.primary?.usedPercent, 100);
  assert.equal(status.secondary?.usedPercent, 66);
  assert.equal(status.planType, "plus");
  assert.equal(status.error, undefined);
});

test("classifyAccountRateLimits: mocked available response -> available", () => {
  const status = classifyAccountRateLimits(loadFixture("codex-account-rate-limits-available.json"));
  assert.equal(status.classification, "available");
  assert.equal(status.rateLimitReachedType, null);
  assert.equal(status.primary?.usedPercent, 12);
});

test("classifyAccountRateLimits: ordinaryUsageAllowed=null, no reachedType -> unknown, not guessed available", () => {
  const status = classifyAccountRateLimits({ ordinaryUsageAllowed: null, rateLimits: { primary: { usedPercent: 3 } } });
  assert.equal(status.classification, "unknown");
  assert.match(status.error ?? "", /no definitive usage signal/);
});

test("classifyAccountRateLimits: missing rateLimits field -> unknown with specific error", () => {
  const status = classifyAccountRateLimits({ ordinaryUsageAllowed: true });
  assert.equal(status.classification, "unknown");
  assert.match(status.error ?? "", /missing the required `rateLimits` field/);
});

test("classifyAccountRateLimits: non-object response -> unknown without throwing", () => {
  const status = classifyAccountRateLimits(null);
  assert.equal(status.classification, "unknown");
  assert.match(status.error ?? "", /malformed/);
});

class FakeTransport implements CodexAppServerTransport {
  public lastRequest: { method: string; params: unknown } | undefined;
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  closed = false;

  constructor(
    private readonly respond: (method: string, params: unknown) => unknown,
  ) {}

  async start(): Promise<void> {}

  async request<T>(method: string, params: unknown): Promise<T> {
    this.lastRequest = { method, params };
    const result = this.respond(method, params);
    if (result instanceof Error) throw result;
    return result as T;
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const set = this.notificationHandlers.get(method) ?? new Set();
    set.add(handler);
    this.notificationHandlers.set(method, set);
    return () => set.delete(handler);
  }

  emit(method: string, params: unknown): void {
    this.notificationHandlers.get(method)?.forEach((h) => h(params));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

test("CodexUsageMonitor.getStatus: happy path calls account/rateLimits/read and classifies the result", async () => {
  const fixture = loadFixture("codex-account-rate-limits-exhausted.json");
  const transport = new FakeTransport((method) => {
    assert.equal(method, "account/rateLimits/read");
    return fixture;
  });
  const monitor = new CodexUsageMonitor(transport);

  const status = await monitor.getStatus();
  assert.equal(status.classification, "exhausted");
  assert.equal(transport.lastRequest?.method, "account/rateLimits/read");
});

test("CodexUsageMonitor.getStatus: connection failure is reported as unknown, never thrown", async () => {
  const transport = new FakeTransport(() => new Error("codex CLI was not found on PATH"));
  const monitor = new CodexUsageMonitor(transport);

  const status = await monitor.getStatus();
  assert.equal(status.classification, "unknown");
  assert.match(status.error ?? "", /not found on PATH/);
});

test("CodexUsageMonitor.getStatus: JSON-RPC protocol error is reported as unknown, never thrown", async () => {
  const transport = new FakeTransport(() => new Error("app-server returned an error response"));
  const monitor = new CodexUsageMonitor(transport);

  const status = await monitor.getStatus();
  assert.equal(status.classification, "unknown");
  assert.match(status.error ?? "", /error response/);
});

test("CodexUsageMonitor.watch: forwards account/rateLimits/updated push notifications", () => {
  const transport = new FakeTransport(() => ({}));
  const monitor = new CodexUsageMonitor(transport);

  const updates: unknown[] = [];
  monitor.watch((status) => updates.push(status));

  transport.emit("account/rateLimits/updated", {
    rateLimits: { rateLimitReachedType: "rate_limit_reached", primary: { usedPercent: 100 } },
  });

  assert.equal(updates.length, 1);
  assert.equal((updates[0] as { classification: string }).classification, "exhausted");
});

test("CodexUsageMonitor.close: delegates to the transport", async () => {
  const transport = new FakeTransport(() => ({}));
  const monitor = new CodexUsageMonitor(transport);
  await monitor.close();
  assert.equal(transport.closed, true);
});
