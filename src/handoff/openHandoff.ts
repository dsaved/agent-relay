import { HandoffStore } from "./store.js";
import { buildContinuationInstruction, buildResumeNudge } from "./instruction.js";
import { defaultCheckProviderActivity } from "./engine.js";
import type { ProviderActivitySignal } from "./lock.js";
import type { HandoffRecord } from "./types.js";
import { DesktopRegistry } from "../desktop/registry.js";
import type { DesktopSessionRecord } from "../desktop/types.js";
import type { SessionProvider } from "../sessions/types.js";
import type { LiveOpenAdapter, LiveOpenResult } from "../execution/types.js";

export interface OpenHandoffLiveOptions {
  to: SessionProvider;
  suppliedObjective?: string;
  forceOpenOverride?: boolean;
}

export interface OpenHandoffLiveResult {
  handoff: HandoffRecord;
  openResult?: LiveOpenResult;
  desktopRecord?: DesktopSessionRecord;
  /** Set whenever nothing was opened: no adapter for this provider, a busy workspace without override, or a missing objective/workspace path. */
  blockedReason?: string;
}

export interface OpenHandoffLiveDeps {
  store?: HandoffStore;
  adapters?: Partial<Record<SessionProvider, LiveOpenAdapter>>;
  checkProviderActivity?: (workspacePath: string) => Promise<ProviderActivitySignal>;
  registry?: DesktopRegistry;
}

/**
 * Phase 8's `handoff open`: launches a live, visible session in the
 * destination's own app instead of `HandoffEngine.executeHandoff`'s
 * headless, captured-to-completion run — see docs/LIVE_HANDOFF.md.
 * Deliberately does not touch `HandoffEngine`/`WorkspaceLockManager`: a
 * live session's completion is human-driven and indefinite, so this
 * never holds the workspace lock, only runs the same one-off activity
 * check `executeHandoff` itself uses before acting.
 */
export async function openHandoffLive(handoffId: string, options: OpenHandoffLiveOptions, deps: OpenHandoffLiveDeps = {}): Promise<OpenHandoffLiveResult> {
  const store = deps.store ?? new HandoffStore();
  const checkProviderActivity = deps.checkProviderActivity ?? defaultCheckProviderActivity;
  const registry = deps.registry ?? new DesktopRegistry({ store });

  const handoff = await store.loadHandoff(handoffId);
  if (!handoff) throw new Error(`no handoff found with id "${handoffId}"`);
  if (handoff.destinationProvider && handoff.destinationProvider !== options.to) {
    throw new Error(`handoff "${handoffId}" already targets "${handoff.destinationProvider}"; cannot redirect to "${options.to}"`);
  }
  if (options.to === handoff.sourceProvider) {
    throw new Error(`cross-provider handoff requires a destination different from the source ("${handoff.sourceProvider}")`);
  }

  const adapter = deps.adapters?.[options.to];
  if (!adapter) {
    return { handoff, blockedReason: `"${options.to}" has no live-open adapter — use \`handoff execute\` instead, or see docs/MULTI_AGENT.md` };
  }

  const objective = handoff.originalTaskObjective ?? options.suppliedObjective ?? null;
  if (!objective) throw new Error(`handoff "${handoffId}" has no recorded task objective — supply one via suppliedObjective before opening`);
  if (!handoff.originalTaskObjective) handoff.originalTaskObjective = objective;

  const workspacePath = handoff.worktreePath ?? handoff.repoRoot;
  if (!workspacePath) {
    return { handoff, blockedReason: `handoff "${handoffId}" has no recorded repository or worktree path` };
  }

  const activitySignal = await checkProviderActivity(workspacePath);
  if (activitySignal.status === "confirmed_busy" && !options.forceOpenOverride) {
    return { handoff, blockedReason: `refusing to open a live session — ${activitySignal.reason} (pass --force-open to override)` };
  }

  const priorAttempt = handoff.attempts.find((a) => a.destinationProvider === options.to && a.destinationSessionId);
  const resumeSessionId = priorAttempt?.destinationSessionId ?? null;
  const instruction = resumeSessionId ? buildResumeNudge() : buildContinuationInstruction(handoff, objective);

  const openResult = await adapter.open({ cwd: workspacePath, instruction, resumeSessionId });

  handoff.destinationProvider = options.to;
  handoff.status = "opened_live";
  await store.saveHandoff(handoff);

  const originatingApp = options.to === "claude" ? "Claude Desktop app" : `${options.to} app (opened live)`;
  const desktopRecord = await registry.registerFromHandoff(handoff, resumeSessionId ?? handoff.handoffId, originatingApp, activitySignal.status, openResult.detail);

  return { handoff, openResult, desktopRecord };
}
