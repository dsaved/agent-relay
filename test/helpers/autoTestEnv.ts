import { createHandoffRecord } from "../../src/handoff/prepare.js";
import { HandoffStore } from "../../src/handoff/store.js";
import type { SessionProvider } from "../../src/sessions/types.js";
import type { UsageSnapshot } from "../../src/usage/types.js";
import type { ProviderActivitySignal } from "../../src/handoff/lock.js";
import { makeSessionAssociation } from "./tempHandoffEnv.js";

export const AVAILABLE: UsageSnapshot = { classification: "available", observedAt: Date.now(), primary: null, secondary: null };
export const UNKNOWN: UsageSnapshot = { classification: "unknown", observedAt: null, primary: null, secondary: null, error: "no observation" };

export function exhausted(resetsAtSeconds: number | null = null): UsageSnapshot {
  return { classification: "exhausted", observedAt: Date.now(), primary: resetsAtSeconds ? { usedPercent: 100, resetsAt: resetsAtSeconds } : null, secondary: null };
}

/** A fake, injectable usage-status function from a fixed map — tests supply exactly what each provider should report. */
export function usageMap(map: Partial<Record<SessionProvider, UsageSnapshot>>): (provider: SessionProvider) => Promise<UsageSnapshot> {
  return async (provider) => map[provider] ?? UNKNOWN;
}

export const CONFIRMED_IDLE: ProviderActivitySignal = { status: "confirmed_idle", reason: "no activity signal configured for this test" };
export const CONFIRMED_BUSY: ProviderActivitySignal = { status: "confirmed_busy", reason: "a session is reported busy for this workspace" };
export const UNKNOWN_ACTIVITY: ProviderActivitySignal = { status: "unknown", reason: "activity cannot be confirmed for this workspace" };

export async function setupAutoTask(
  store: HandoffStore,
  repoRoot: string,
  sourceProvider: SessionProvider,
  overrides: { title?: string | null } = {},
): Promise<{ taskId: string; handoffId: string }> {
  const session = makeSessionAssociation({ provider: sourceProvider, repoRoot, workspaceAccessible: true, title: overrides.title ?? "Implement the thing" });
  const { task, handoff } = await createHandoffRecord(session);
  await store.saveTask(task);
  await store.saveHandoff(handoff);
  return { taskId: task.taskId, handoffId: handoff.handoffId };
}
