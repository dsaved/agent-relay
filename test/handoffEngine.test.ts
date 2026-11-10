import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandoffRecord } from "../src/handoff/prepare.js";
import { HandoffStore } from "../src/handoff/store.js";
import { HandoffEngine } from "../src/handoff/engine.js";
import { buildResumeNudge } from "../src/handoff/instruction.js";
import type { HandoffRecord, Task } from "../src/handoff/types.js";
import type { AgentExecutionAdapter } from "../src/execution/types.js";
import type { SessionProvider } from "../src/sessions/types.js";
import type { UsageSnapshot } from "../src/usage/types.js";
import { withTempRepo } from "./helpers/tempGitRepo.js";
import { makeSessionAssociation, withTempStoreRoot } from "./helpers/tempHandoffEnv.js";
import { FakeExecutionAdapter, fakeOutcome, fakeResult } from "./helpers/fakeExecutionAdapter.js";

interface Ctx {
  repoRoot: string;
  store: HandoffStore;
  prepareAndSave: (sessionOverrides?: Parameters<typeof makeSessionAssociation>[0]) => Promise<{ task: Task; handoff: HandoffRecord }>;
}

async function withEnv(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  await withTempRepo(async (repoRoot) => {
    await withTempStoreRoot(async (storeRoot) => {
      const store = new HandoffStore(storeRoot);
      await run({
        repoRoot,
        store,
        async prepareAndSave(sessionOverrides = {}) {
          const session = makeSessionAssociation({ repoRoot, workspaceAccessible: true, ...sessionOverrides });
          const { task, handoff } = await createHandoffRecord(session);
          await store.saveTask(task);
          await store.saveHandoff(handoff);
          return { task, handoff };
        },
      });
    });
  });
}

const AVAILABLE: UsageSnapshot = { classification: "available", observedAt: Date.now(), primary: null, secondary: null };
const EXHAUSTED: UsageSnapshot = { classification: "exhausted", observedAt: Date.now(), primary: { usedPercent: 100, resetsAt: null }, secondary: null };
const UNKNOWN: UsageSnapshot = { classification: "unknown", observedAt: null, primary: null, secondary: null, error: "no observation fed" };

function engineFor(
  store: HandoffStore,
  destAdapter: AgentExecutionAdapter,
  opts: { usage?: UsageSnapshot; activity?: () => Promise<{ status: "confirmed_busy" | "confirmed_idle" | "unknown"; reason: string }> } = {},
): HandoffEngine {
  const adapters: Partial<Record<SessionProvider, AgentExecutionAdapter>> = { [destAdapter.provider]: destAdapter };
  return new HandoffEngine({
    store,
    adapters,
    getUsageStatus: async () => opts.usage ?? AVAILABLE,
    checkProviderActivity: opts.activity ?? (async () => ({ status: "confirmed_idle", reason: "no activity signal configured for this test" })),
  });
}

test("codex-to-claude handoff: completes, records destination session id and attempt history", async () => {
  await withEnv(async (ctx) => {
    const { handoff } = await ctx.prepareAndSave({ provider: "codex" });
    const dest = new FakeExecutionAdapter("claude", () => fakeResult("claude", { sessionId: "claude-dest-1" }));
    const engine = engineFor(ctx.store, dest);

    const result = await engine.executeHandoff(handoff.handoffId, { to: "claude" });

    assert.equal(result.handoff.status, "completed");
    assert.equal(result.handoff.destinationProvider, "claude");
    assert.equal(result.attempt.destinationSessionId, "claude-dest-1");
    assert.equal(result.attempt.usageDecision, "started");
    assert.equal(dest.calls.length, 1);
    assert.match(dest.calls[0]?.instruction ?? "", /Implement the thing/);
  });
});

test("claude-to-codex handoff: completes, records destination session id", async () => {
  await withEnv(async (ctx) => {
    const { handoff } = await ctx.prepareAndSave({ provider: "claude" });
    const dest = new FakeExecutionAdapter("codex", () => fakeResult("codex", { sessionId: "codex-dest-1" }));
    const engine = engineFor(ctx.store, dest);

    const result = await engine.executeHandoff(handoff.handoffId, { to: "codex" });

    assert.equal(result.handoff.status, "completed");
    assert.equal(result.attempt.destinationSessionId, "codex-dest-1");
  });
});

test("rejects same-provider 'handoff' as not cross-provider", async () => {
  await withEnv(async (ctx) => {
    const { handoff } = await ctx.prepareAndSave({ provider: "codex" });
    const dest = new FakeExecutionAdapter("codex", () => fakeResult("codex"));
    const engine = engineFor(ctx.store, dest);
    await assert.rejects(() => engine.executeHandoff(handoff.handoffId, { to: "codex" }), /different from the source/);
  });
});

test("partial implementation preservation: a timed-out run is marked interrupted, not lost, with its destination session id retained", async () => {
  await withEnv(async (ctx) => {
    const { handoff } = await ctx.prepareAndSave({ provider: "codex" });
    const dest = new FakeExecutionAdapter("claude", () => fakeResult("claude", { sessionId: "claude-partial-1", outcome: fakeOutcome("timed_out", "exceeded timeout") }));
    const engine = engineFor(ctx.store, dest);

    const result = await engine.executeHandoff(handoff.handoffId, { to: "claude" });

    assert.equal(result.handoff.status, "interrupted");
    assert.equal(result.attempt.destinationSessionId, "claude-partial-1");
    assert.equal(result.attempt.outcome?.kind, "timed_out");
  });
});

test("missing task objective: refuses until one is supplied, then proceeds and persists it", async () => {
  await withEnv(async (ctx) => {
    const { handoff } = await ctx.prepareAndSave({ provider: "codex", title: null });
    const dest = new FakeExecutionAdapter("claude", () => fakeResult("claude", { sessionId: "claude-x" }));
    const engine = engineFor(ctx.store, dest);

    await assert.rejects(() => engine.executeHandoff(handoff.handoffId, { to: "claude" }), /no recorded task objective/);
    assert.equal(dest.calls.length, 0);

    const result = await engine.executeHandoff(handoff.handoffId, { to: "claude", suppliedObjective: "Finish the parser" });
    assert.equal(result.handoff.status, "completed");
    assert.equal(result.handoff.originalTaskObjective, "Finish the parser");
    assert.match(dest.calls[0]?.instruction ?? "", /Finish the parser/);
  });
});

test("missing repository directory: refuses before ever calling the destination adapter", async () => {
  await withEnv(async (ctx) => {
    const session = makeSessionAssociation({ provider: "codex", repoRoot: "/definitely/does/not/exist/agent-relay", workspaceAccessible: false });
    const { task, handoff } = await createHandoffRecord(session);
    await ctx.store.saveTask(task);
    await ctx.store.saveHandoff(handoff);

    const dest = new FakeExecutionAdapter("claude", () => fakeResult("claude"));
    const engine = engineFor(ctx.store, dest);

    const result = await engine.executeHandoff(handoff.handoffId, { to: "claude" });
    assert.equal(result.handoff.status, "blocked");
    assert.match(result.blockedReason ?? "", /not accessible/);
    assert.equal(dest.calls.length, 0);
  });
});

test("exhausted destination provider: refuses before ever calling the destination adapter", async () => {
  await withEnv(async (ctx) => {
    const { handoff } = await ctx.prepareAndSave({ provider: "codex" });
    const dest = new FakeExecutionAdapter("claude", () => fakeResult("claude"));
    const engine = engineFor(ctx.store, dest, { usage: EXHAUSTED });

    const result = await engine.executeHandoff(handoff.handoffId, { to: "claude" });
    assert.equal(result.handoff.status, "blocked");
    assert.equal(result.attempt.usageDecision, "blocked_exhausted");
    assert.match(result.blockedReason ?? "", /exhausted/);
    assert.equal(dest.calls.length, 0);
  });
});

test("unknown destination usage status: proceeds with caution rather than blocking an explicit execute", async () => {
  await withEnv(async (ctx) => {
    const { handoff } = await ctx.prepareAndSave({ provider: "codex" });
    const dest = new FakeExecutionAdapter("claude", () => fakeResult("claude", { sessionId: "claude-y" }));
    const engine = engineFor(ctx.store, dest, { usage: UNKNOWN });

    const result = await engine.executeHandoff(handoff.handoffId, { to: "claude" });
    assert.equal(result.handoff.status, "completed");
    assert.equal(result.attempt.usageDecision, "proceeded_with_caution");
    assert.equal(dest.calls.length, 1);
  });
});

test("agent crash: reported as interrupted, never thrown, lock released", async () => {
  await withEnv(async (ctx) => {
    const { handoff } = await ctx.prepareAndSave({ provider: "codex" });
    const dest = new FakeExecutionAdapter("claude", () => fakeResult("claude", { exitCode: 1, outcome: fakeOutcome("crashed", "claude exited with code 1") }));
    const engine = engineFor(ctx.store, dest);

    const result = await engine.executeHandoff(handoff.handoffId, { to: "claude" });
    assert.equal(result.handoff.status, "interrupted");
    assert.equal(result.attempt.outcome?.kind, "crashed");
  });
});

test("invalid/unparseable execution output: reported as interrupted, never thrown", async () => {
  await withEnv(async (ctx) => {
    const { handoff } = await ctx.prepareAndSave({ provider: "codex" });
    const dest = new FakeExecutionAdapter("claude", () => fakeResult("claude", { outcome: fakeOutcome("invalid_output", "no recognizable events") }));
    const engine = engineFor(ctx.store, dest);

    const result = await engine.executeHandoff(handoff.handoffId, { to: "claude" });
    assert.equal(result.handoff.status, "interrupted");
    assert.equal(result.attempt.outcome?.kind, "invalid_output");
  });
});

test("permission-required event: classified distinctly, not confused with a completed or crashed run", async () => {
  await withEnv(async (ctx) => {
    const { handoff } = await ctx.prepareAndSave({ provider: "codex" });
    const dest = new FakeExecutionAdapter("claude", () => fakeResult("claude", { sessionId: "claude-perm", outcome: fakeOutcome("permission_required", "needs approval to write file") }));
    const engine = engineFor(ctx.store, dest);

    const result = await engine.executeHandoff(handoff.handoffId, { to: "claude" });
    assert.equal(result.handoff.status, "interrupted");
    assert.equal(result.attempt.outcome?.kind, "permission_required");
  });
});

test("validation failure: a completed run with a failing configured validation command becomes failed_validation, not completed", async () => {
  await withEnv(async (ctx) => {
    const { handoff } = await ctx.prepareAndSave({ provider: "codex" });
    const dest = new FakeExecutionAdapter("claude", () => fakeResult("claude", { sessionId: "claude-val-1" }));
    const engine = engineFor(ctx.store, dest);

    const result = await engine.executeHandoff(handoff.handoffId, {
      to: "claude",
      validationCommands: [`"${process.execPath}" -e "process.exit(1)"`],
    });

    assert.equal(result.handoff.status, "failed_validation");
    assert.equal(result.attempt.validationResults?.[0]?.passed, false);
  });
});

test("validation success: a completed run with passing configured validation commands stays completed", async () => {
  await withEnv(async (ctx) => {
    const { handoff } = await ctx.prepareAndSave({ provider: "codex" });
    const dest = new FakeExecutionAdapter("claude", () => fakeResult("claude", { sessionId: "claude-val-2" }));
    const engine = engineFor(ctx.store, dest);

    const result = await engine.executeHandoff(handoff.handoffId, {
      to: "claude",
      validationCommands: [`"${process.execPath}" -e "process.exit(0)"`],
    });

    assert.equal(result.handoff.status, "completed");
    assert.equal(result.attempt.validationResults?.[0]?.passed, true);
  });
});

test("interrupted handoff recovery: a second execute() resumes the same destination session instead of starting over", async () => {
  await withEnv(async (ctx) => {
    const { handoff } = await ctx.prepareAndSave({ provider: "codex" });
    const dest = new FakeExecutionAdapter("claude", (_options, callIndex) =>
      callIndex === 0
        ? fakeResult("claude", { sessionId: "claude-resume-1", outcome: fakeOutcome("crashed", "simulated crash") })
        : fakeResult("claude", { sessionId: "claude-resume-1" }),
    );
    const engine = engineFor(ctx.store, dest);

    const first = await engine.executeHandoff(handoff.handoffId, { to: "claude" });
    assert.equal(first.handoff.status, "interrupted");

    const second = await engine.executeHandoff(handoff.handoffId, { to: "claude" });
    assert.equal(dest.calls.length, 2);
    assert.equal(dest.calls[1]?.resumeSessionId, "claude-resume-1");
    assert.equal(dest.calls[1]?.instruction, buildResumeNudge());
    assert.equal(second.handoff.status, "completed");
    assert.equal(second.attempt.destinationSessionId, "claude-resume-1");
  });
});
