import { HandoffEngine } from "../handoff/engine.js";
import { HandoffStore } from "../handoff/store.js";
import type { SessionProvider } from "../sessions/types.js";
import { DesktopRegistry } from "./registry.js";
import type { DesktopSessionRecord } from "./types.js";

export interface DesktopHandoffOptions {
  to: SessionProvider;
  forceLockOverride?: boolean;
  validationCommands?: string[];
  timeoutMs?: number;
}

export interface DesktopHandoffResult {
  record: DesktopSessionRecord;
  /** Set when the transfer never reached `HandoffEngine` at all — insufficient evidence and no `--force-lock`. Mirrors `AutomaticHandoffCoordinator`'s own "blocked, never forced" behavior (Phase 3A). */
  blockedReason?: string;
  handoffId?: string;
  taskId?: string;
}

/**
 * Requirement #6's continuation glue: assess ownership (§2) fresh, then
 * reuse `HandoffEngine`/`createHandoffRecord` exactly as `handoff execute`
 * already does — no new execution path. `--force-lock` is passed through
 * only when the caller explicitly set it on this one call; it is never
 * set automatically by this function.
 */
export async function requestDesktopHandoff(
  sessionId: string,
  options: DesktopHandoffOptions,
  deps: { registry?: DesktopRegistry; store?: HandoffStore; engine?: HandoffEngine } = {},
): Promise<DesktopHandoffResult> {
  const store = deps.store ?? new HandoffStore();
  const registry = deps.registry ?? new DesktopRegistry({ store });
  const engine = deps.engine ?? new HandoffEngine({ store });

  const { record, canTakeOwnership } = await registry.refreshOwnership(sessionId, true);

  if (!canTakeOwnership && !options.forceLockOverride) {
    return { record, blockedReason: `workspace ownership could not be confirmed safe (${record.ownershipStatus}): ${record.evidence[record.evidence.length - 1]?.detail ?? "no evidence recorded"}` };
  }

  const { taskId, handoffId } = await registry.ensureTask(sessionId);
  const result = await engine.executeHandoff(handoffId, {
    to: options.to,
    forceLockOverride: options.forceLockOverride, // explicit per-call only — never set by this function on its own
    validationCommands: options.validationCommands,
    timeoutMs: options.timeoutMs,
  });

  if (!result.blockedReason) {
    // The lock was acquired and has since been released (HandoffEngine's
    // own finally block) by the time executeHandoff resolves — a clean
    // handback regardless of the attempt's outcome kind.
    await registry.markReleased(sessionId, taskId);
  }

  const refreshed = await registry.get(sessionId);
  return { record: refreshed ?? record, blockedReason: result.blockedReason, handoffId, taskId };
}
