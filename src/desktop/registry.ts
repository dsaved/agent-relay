import { discoverAllSessions } from "../sessions/discoverAll.js";
import type { SessionAssociation } from "../sessions/types.js";
import { HandoffStore } from "../handoff/store.js";
import { WorkspaceLockManager, type ProviderActivitySignal } from "../handoff/lock.js";
import { defaultCheckProviderActivity } from "../handoff/engine.js";
import { createHandoffRecord } from "../handoff/prepare.js";
import { assessDesktopOwnership } from "./ownership.js";
import type { ActivityStatus } from "../handoff/lock.js";
import type { HandoffRecord } from "../handoff/types.js";
import type { DesktopSessionRecord, HookEventPayload } from "./types.js";

export interface DesktopRegistryDeps {
  store?: HandoffStore;
  lockManager?: WorkspaceLockManager;
  checkProviderActivity?: (workspacePath: string) => Promise<ProviderActivitySignal>;
  discover?: typeof discoverAllSessions;
}

/** Best-effort, from the provider's own discovery metadata — never a guess beyond what the discovery adapter already recorded (Phase 2A `source`/`originator`, Phase 0 #11's Claude/Codex distinction). */
export function inferOriginatingApp(session: SessionAssociation): string {
  const match = /\(([^)]+)\)/.exec(session.discoverySource);
  if (match) {
    const parts = match[1]!.split("/").map((p) => p.trim());
    const named = parts.find((p) => /desktop/i.test(p));
    if (named) return named;
  }
  return session.provider === "codex" ? "Codex CLI" : "Claude Code CLI";
}

export class DesktopSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session "${sessionId}" was not found among currently discovered sessions`);
  }
}

export class MissingObjectiveError extends Error {
  constructor(sessionId: string) {
    super(`session "${sessionId}" has no recorded title — supply --objective explicitly`);
  }
}

/**
 * Desktop session registration + ownership tracking (requirements #1, #2,
 * #5). Reuses Phase 2A discovery, Phase 2C's lock/activity primitives, and
 * `HandoffStore`'s atomic persistence unchanged — this module only adds
 * the desktop-specific record and the 7-state assessment in ownership.ts.
 */
export class DesktopRegistry {
  private readonly store: HandoffStore;
  private readonly lockManager: WorkspaceLockManager;
  private readonly checkProviderActivity: (workspacePath: string) => Promise<ProviderActivitySignal>;
  private readonly discover: typeof discoverAllSessions;

  constructor(deps: DesktopRegistryDeps = {}) {
    this.store = deps.store ?? new HandoffStore();
    this.lockManager = deps.lockManager ?? new WorkspaceLockManager(this.store);
    this.checkProviderActivity = deps.checkProviderActivity ?? defaultCheckProviderActivity;
    this.discover = deps.discover ?? discoverAllSessions;
  }

  private async findSession(sessionId: string): Promise<SessionAssociation> {
    const { sessions } = await this.discover();
    const match = sessions.find((s) => s.sessionId === sessionId);
    if (!match) throw new DesktopSessionNotFoundError(sessionId);
    return match;
  }

  /**
   * Registers one discovered session as a desktop task source. Never
   * merges with another record sharing a `repoRoot` — each discovered
   * session/thread id gets its own `DesktopSessionRecord`, same rule
   * `projectAssociation.ts` already enforces for grouping-by-project.
   */
  async register(sessionId: string, objectiveOverride?: string | null): Promise<DesktopSessionRecord> {
    const session = await this.findSession(sessionId);
    const objective = objectiveOverride ?? session.title;
    if (!objective) throw new MissingObjectiveError(sessionId);

    const workspacePath = session.worktreePath ?? session.repoRoot;
    const activitySignal = workspacePath ? await this.checkProviderActivity(workspacePath) : { status: "unknown" as const, reason: "no workspace path could be resolved for this session" };
    const heldByThisProcess = workspacePath ? await this.lockManager.isHeldByThisProcess(workspacePath) : false;
    const assessment = assessDesktopOwnership({ priorState: null, heldByThisProcess, activitySignal, handoffAuthorizedNow: false, sourceProcessGroupTerminated: false });

    const now = Date.now();
    const record: DesktopSessionRecord = {
      provider: session.provider,
      sessionId: session.sessionId,
      repoRoot: session.repoRoot,
      worktreePath: session.worktreePath,
      originatingApp: inferOriginatingApp(session),
      objective,
      observedActivity: activitySignal.status,
      lastConfirmedActivityAt: now,
      associatedTaskId: null,
      ownershipStatus: assessment.state,
      evidence: [{ at: now, source: "desktop register", detail: assessment.reason }],
      registeredAt: now,
      updatedAt: now,
    };
    await this.store.saveDesktopSession(record);
    return record;
  }

  /**
   * Phase 8's `handoff open` registers the newly-opened live session this
   * way instead of `register()`, which expects a session this process
   * already discovered — a brand-new destination session doesn't exist
   * to discover yet. Keyed by `sessionId` (the destination's own session
   * id when known, otherwise the handoff's own id as a stand-in so
   * `desktop inspect <id>` still finds it) with `ownershipStatus:
   * "external_active"`: Relay hands this workspace to the human/app
   * immediately, it never holds a lock across a live session's lifetime.
   */
  async registerFromHandoff(handoff: HandoffRecord, sessionId: string, originatingApp: string, observedActivity: ActivityStatus, evidenceDetail: string): Promise<DesktopSessionRecord> {
    const now = Date.now();
    const record: DesktopSessionRecord = {
      provider: handoff.destinationProvider ?? handoff.sourceProvider,
      sessionId,
      repoRoot: handoff.repoRoot,
      worktreePath: handoff.worktreePath,
      originatingApp,
      objective: handoff.originalTaskObjective ?? "(none recorded)",
      observedActivity,
      lastConfirmedActivityAt: now,
      associatedTaskId: handoff.taskId,
      ownershipStatus: "external_active",
      evidence: [{ at: now, source: "handoff open", detail: evidenceDetail }],
      registeredAt: now,
      updatedAt: now,
    };
    await this.store.saveDesktopSession(record);
    return record;
  }

  async get(sessionId: string): Promise<DesktopSessionRecord | null> {
    return this.store.loadDesktopSession(sessionId);
  }

  async list(): Promise<DesktopSessionRecord[]> {
    const ids = await this.store.listDesktopSessionIds();
    const records = await Promise.all(ids.map((id) => this.store.loadDesktopSession(id)));
    return records.filter((r): r is DesktopSessionRecord => r !== null);
  }

  /** Appends one piece of evidence (a hook event, a manual note) without re-deriving ownership — use `refreshOwnership` for that. */
  async recordEvidence(sessionId: string, source: string, detail: string): Promise<DesktopSessionRecord | null> {
    const record = await this.store.loadDesktopSession(sessionId);
    if (!record) return null;
    const now = Date.now();
    const updated: DesktopSessionRecord = { ...record, evidence: [...record.evidence, { at: now, source, detail }], updatedAt: now };
    await this.store.saveDesktopSession(updated);
    return updated;
  }

  /**
   * Re-derives ownership fresh from real signals (requirement #2's "never
   * treat a user confirmation as permanent permission"). `authorizeNow`
   * is true only on the exact call that is itself the user's explicit
   * `desktop handoff` request.
   */
  async refreshOwnership(sessionId: string, authorizeNow: boolean): Promise<{ record: DesktopSessionRecord; canTakeOwnership: boolean }> {
    const record = await this.store.loadDesktopSession(sessionId);
    if (!record) throw new DesktopSessionNotFoundError(sessionId);
    const workspacePath = record.worktreePath ?? record.repoRoot;
    if (!workspacePath) throw new Error(`session "${sessionId}" has no recorded repository or worktree path`);

    const activitySignal = await this.checkProviderActivity(workspacePath);
    const heldByThisProcess = await this.lockManager.isHeldByThisProcess(workspacePath);
    const sourceProcessGroupTerminated = await this.lockManager.wasRelayWorkerThatHasTerminated(workspacePath);

    const assessment = assessDesktopOwnership({
      priorState: record.ownershipStatus,
      heldByThisProcess,
      activitySignal,
      handoffAuthorizedNow: authorizeNow,
      sourceProcessGroupTerminated,
    });

    const now = Date.now();
    const updated: DesktopSessionRecord = {
      ...record,
      observedActivity: activitySignal.status,
      lastConfirmedActivityAt: now,
      ownershipStatus: assessment.state,
      evidence: [...record.evidence, { at: now, source: authorizeNow ? "desktop handoff (authorized)" : "ownership refresh", detail: assessment.reason }],
      updatedAt: now,
    };
    await this.store.saveDesktopSession(updated);
    return { record: updated, canTakeOwnership: assessment.canTakeOwnership };
  }

  /** Marks a successful, clean handback — set directly, not re-derived (see ownership.ts's doc comment on why `released` isn't produced by the pure function). */
  async markReleased(sessionId: string, taskId: string | null): Promise<void> {
    const record = await this.store.loadDesktopSession(sessionId);
    if (!record) return;
    const now = Date.now();
    await this.store.saveDesktopSession({
      ...record,
      ownershipStatus: "released",
      associatedTaskId: taskId ?? record.associatedTaskId,
      evidence: [...record.evidence, { at: now, source: "desktop handoff", detail: "execution finished; workspace lock released cleanly" }],
      updatedAt: now,
    });
  }

  /** Builds (or reuses, if already associated) the durable Task/HandoffRecord this session's work is tracked under — reusing `createHandoffRecord` exactly as `handoff prepare` does. */
  async ensureTask(sessionId: string): Promise<{ taskId: string; handoffId: string }> {
    const record = await this.store.loadDesktopSession(sessionId);
    if (!record) throw new DesktopSessionNotFoundError(sessionId);
    if (record.associatedTaskId) {
      const task = await this.store.loadTask(record.associatedTaskId);
      const lastHandoffId = task?.handoffIds[task.handoffIds.length - 1];
      if (task && lastHandoffId) return { taskId: task.taskId, handoffId: lastHandoffId };
    }

    const session = await this.findSession(sessionId);
    const { task, handoff } = await createHandoffRecord(session, { handoffReason: `desktop registration: ${record.objective}` });
    await this.store.saveTask(task);
    await this.store.saveHandoff(handoff);
    await this.store.saveDesktopSession({ ...record, associatedTaskId: task.taskId, updatedAt: Date.now() });
    return { taskId: task.taskId, handoffId: handoff.handoffId };
  }
}

/** Parses one Claude Code hook JSON payload from stdin — see docs/DESKTOP_INTEGRATION.md §4. Never throws: malformed input is reported as a validation message, not an exception. */
export function parseHookEvent(raw: string): { payload: HookEventPayload } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "hook-event input was not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "hook-event input was not a JSON object" };
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.session_id !== "string" || !obj.session_id) return { error: "hook-event input is missing a string `session_id`" };
  if (typeof obj.hook_event_name !== "string" || !obj.hook_event_name) return { error: "hook-event input is missing a string `hook_event_name`" };
  return { payload: obj as HookEventPayload };
}
