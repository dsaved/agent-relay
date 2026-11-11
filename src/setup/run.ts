import { ClaudeCodeAdapter } from "./claudeCodeAdapter.js";
import { CodexAdapter } from "./codexAdapter.js";
import { CopilotAdapter } from "./copilotAdapter.js";
import { DaemonLaunchdAdapter } from "./daemonAdapter.js";
import { checkEnvironment, type EnvironmentCheck } from "./environment.js";
import { checkClaudeAuthStatus, checkCodexAuthStatus, checkCopilotAuthStatus, type AuthStatus } from "./authCheck.js";
import type { ApplyResult, IntegrationAdapter, IntegrationChange, IntegrationStatus, DetectionResult } from "./adapter.js";

export function defaultAdapters(): IntegrationAdapter[] {
  return [new ClaudeCodeAdapter(), new CodexAdapter(), new CopilotAdapter(), new DaemonLaunchdAdapter()];
}

/** Requirement #2 steps 1/3: OS/runtime + subscription-auth-without-credentials, reported once up front, before any adapter's plan. */
export async function checkSetupPrerequisites(): Promise<{ environment: EnvironmentCheck; auth: AuthStatus[] }> {
  const environment = checkEnvironment();
  const auth = await Promise.all([checkClaudeAuthStatus(), checkCodexAuthStatus(), checkCopilotAuthStatus()]);
  return { environment, auth };
}

export function formatSetupPrerequisites(prereqs: { environment: EnvironmentCheck; auth: AuthStatus[] }): string {
  const lines = [`environment: ${prereqs.environment.detail}`];
  for (const a of prereqs.auth) lines.push(`auth [${a.provider}]: ${a.authenticated ? "authenticated" : "not authenticated"} (${a.detail})`);
  return lines.join("\n");
}

export interface SetupPlanSummary {
  adapterId: string;
  detection: DetectionResult;
  changes: IntegrationChange[];
  /** Set when `plan()` itself refused (e.g. an unparseable existing config file) — requirement #3's "never guess" surfaced up front, before any approval prompt. */
  planError: string | null;
}

/** Requirement #1/#4's discovery + plan step — entirely read-only. Only agents `detect()` reports as installed are even asked for a plan; an agent that isn't there has nothing to propose. */
export async function planSetup(adapters: IntegrationAdapter[]): Promise<SetupPlanSummary[]> {
  const summaries: SetupPlanSummary[] = [];
  for (const adapter of adapters) {
    const detection = await adapter.detect();
    if (!detection.installed) {
      summaries.push({ adapterId: adapter.id, detection, changes: [], planError: null });
      continue;
    }
    try {
      summaries.push({ adapterId: adapter.id, detection, changes: await adapter.plan(), planError: null });
    } catch (err) {
      summaries.push({ adapterId: adapter.id, detection, changes: [], planError: err instanceof Error ? err.message : String(err) });
    }
  }
  return summaries;
}

export interface SetupApplyOutcome {
  adapterId: string;
  result: ApplyResult | null;
  error: string | null;
}

/** Requirement #2's "after the user approves" step — callers (the CLI's `setup` command) are responsible for gating this behind actual approval; this function itself only ever applies the changes a prior `planSetup()` call already described. */
export async function applySetup(adapters: IntegrationAdapter[], summaries: SetupPlanSummary[]): Promise<SetupApplyOutcome[]> {
  const outcomes: SetupApplyOutcome[] = [];
  for (const summary of summaries) {
    if (summary.changes.length === 0 || summary.planError) continue;
    const adapter = adapters.find((a) => a.id === summary.adapterId);
    if (!adapter) continue;
    try {
      outcomes.push({ adapterId: adapter.id, result: await adapter.apply(), error: null });
    } catch (err) {
      outcomes.push({ adapterId: adapter.id, result: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcomes;
}

export async function statusAll(adapters: IntegrationAdapter[]): Promise<IntegrationStatus[]> {
  return Promise.all(adapters.map((a) => a.status()));
}

export interface RepairOutcome {
  adapterId: string;
  repaired: boolean;
  result: ApplyResult | null;
  error: string | null;
}

/** Requirement #8: repairs only what `status()` actually found missing/broken for each adapter — never a blind full re-apply of an adapter that's already fully installed. */
export async function repairAll(adapters: IntegrationAdapter[]): Promise<RepairOutcome[]> {
  const outcomes: RepairOutcome[] = [];
  for (const adapter of adapters) {
    const status = await adapter.status();
    const needsRepair = status.entries.some((e) => e.status === "missing" || e.status === "broken");
    if (!needsRepair) {
      outcomes.push({ adapterId: adapter.id, repaired: false, result: null, error: null });
      continue;
    }
    try {
      outcomes.push({ adapterId: adapter.id, repaired: true, result: await adapter.repair(), error: null });
    } catch (err) {
      outcomes.push({ adapterId: adapter.id, repaired: false, result: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcomes;
}

export interface UninstallOutcome {
  adapterId: string;
  result: ApplyResult | null;
  error: string | null;
}

/** Requirement #9: removes only this tool's own entries, per adapter — `ClaudeCodeAdapter.uninstall()`'s own marker-based removal is what actually enforces "only Agent Relay's own configuration entries". */
export async function uninstallAll(adapters: IntegrationAdapter[]): Promise<UninstallOutcome[]> {
  const outcomes: UninstallOutcome[] = [];
  for (const adapter of adapters) {
    try {
      outcomes.push({ adapterId: adapter.id, result: await adapter.uninstall(), error: null });
    } catch (err) {
      outcomes.push({ adapterId: adapter.id, result: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcomes;
}

export function formatSetupPlan(summaries: SetupPlanSummary[]): string {
  const lines: string[] = [];
  for (const s of summaries) {
    lines.push(`[${s.adapterId}] ${s.detection.detail}`);
    if (s.planError) {
      lines.push(`  error: ${s.planError}`);
    } else if (!s.detection.installed) {
      lines.push("  (not installed — nothing to plan)");
    } else if (s.changes.length === 0) {
      lines.push("  already up to date — nothing to do");
    } else {
      for (const c of s.changes) lines.push(`  + ${c.description}`);
    }
  }
  return lines.join("\n");
}

export function formatApplyOutcomes(outcomes: SetupApplyOutcome[]): string {
  if (outcomes.length === 0) return "Nothing to apply.";
  const lines: string[] = [];
  for (const o of outcomes) {
    if (o.error) {
      lines.push(`[${o.adapterId}] FAILED: ${o.error}`);
      continue;
    }
    for (const c of o.result!.applied) lines.push(`[${o.adapterId}] ${c.description}`);
    for (const b of o.result!.backupPaths) lines.push(`[${o.adapterId}]   backup saved: ${b}`);
  }
  return lines.join("\n");
}

export function formatStatusAll(statuses: IntegrationStatus[]): string {
  const lines: string[] = [];
  for (const s of statuses) {
    lines.push(`[${s.id}] ${s.detection.detail}`);
    for (const e of s.entries) lines.push(`  ${e.status}: ${e.change.description} (${e.detail})`);
  }
  return lines.join("\n");
}

export function formatRepairOutcomes(outcomes: RepairOutcome[]): string {
  const lines: string[] = [];
  for (const o of outcomes) {
    if (o.error) {
      lines.push(`[${o.adapterId}] FAILED: ${o.error}`);
    } else if (!o.repaired) {
      lines.push(`[${o.adapterId}] already fine — nothing to repair`);
    } else {
      for (const c of o.result!.applied) lines.push(`[${o.adapterId}] repaired: ${c.description}`);
      if (o.result!.applied.length === 0) lines.push(`[${o.adapterId}] repair ran but found nothing to change`);
    }
  }
  return lines.join("\n");
}

export function formatUninstallOutcomes(outcomes: UninstallOutcome[]): string {
  const lines: string[] = [];
  for (const o of outcomes) {
    if (o.error) {
      lines.push(`[${o.adapterId}] FAILED: ${o.error}`);
    } else if (o.result!.noopAlreadyUpToDate) {
      lines.push(`[${o.adapterId}] nothing installed — nothing to remove`);
    } else {
      for (const c of o.result!.applied) lines.push(`[${o.adapterId}] ${c.description}`);
      for (const b of o.result!.backupPaths) lines.push(`[${o.adapterId}]   backup saved: ${b}`);
    }
  }
  return lines.join("\n");
}
