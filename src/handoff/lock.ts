import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isWorkspaceAccessible } from "../sessions/projectAssociation.js";
import { HandoffStore } from "./store.js";
import type { WorkspaceLockRecord } from "./types.js";

/**
 * Resolves symlinks before hashing, so a workspace reached through a
 * path alias (a symlinked directory, or a worktree path that happens to
 * traverse one) maps to the exact same lock key as the real path — two
 * callers locking "different-looking" paths that are actually the same
 * physical workspace must collide, not coexist. Falls back to the raw
 * path only if it can't be resolved at all (the accessibility check
 * upstream already means this is rare).
 */
export async function lockKeyFor(workspacePath: string): Promise<string> {
  let resolved = workspacePath;
  try {
    resolved = await realpath(workspacePath);
  } catch {
    // leave `resolved` as the raw path — better to lock on it than crash
  }
  return createHash("sha256").update(resolved).digest("hex").slice(0, 32);
}

/**
 * `process.kill(pid, 0)` without actually sending a signal — the
 * standard liveness probe. ESRCH = gone; EPERM = alive but owned by
 * someone else; no error = alive and ours.
 *
 * Known limitation (PID reuse): a dead PID's number can be reassigned
 * by the OS to an unrelated live process. This function cannot tell the
 * difference — and by design it doesn't try to. The safety property
 * that matters is preserved regardless: any PID that reports alive is
 * treated as a potential real holder and refused without
 * `forceOverride`, whether or not it's genuinely the original one. The
 * failure mode this leaves is overly cautious (a stale lock might look
 * "live" a little longer than true), never unsafe (a live writer is
 * never mistaken for safe to steal).
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type ActivityStatus = "confirmed_busy" | "confirmed_idle" | "unknown";

export interface ProviderActivitySignal {
  status: ActivityStatus;
  reason: string;
}

export type AcquireResult =
  | { acquired: true; overrideUsed: boolean; recoveredFromCrash: boolean; activitySignal: ProviderActivitySignal | null }
  | { acquired: false; reason: string; activitySignal: ProviderActivitySignal | null };

export interface AcquireOptions {
  /**
   * A real check in production (re-discovers sessions for this path,
   * including the handoff's own source session — see
   * docs/HANDOFF_ENGINE.md on why that's no longer excluded); tests
   * inject a fake. Unlike Phase 2B, "unknown" is no longer treated as
   * safe: only `confirmed_idle` proceeds without `forceOverride`.
   */
  checkProviderActivity?: () => Promise<ProviderActivitySignal>;
  forceOverride?: boolean;
}

/**
 * Exclusive per-workspace lock with crash recovery. A lock's mere
 * presence, or its age, is never treated as proof an old writer has
 * stopped — only three things let a new holder in: (a) the recorded
 * holder PID is genuinely no longer running, (b) a provider activity
 * check positively confirms idle (never merely "no signal"), or (c) the
 * caller explicitly overrides (`forceOverride` — wired to the CLI's
 * `--force-lock`, an explicit, user-initiated action only).
 *
 * Fresh acquisition (nobody has ever held this lock) is atomic at the
 * filesystem level (`O_EXCL` create, via `HandoffStore.createLockExclusive`)
 * specifically so two controllers racing to acquire the *same, currently
 * unheld* workspace can never both win.
 */
export class WorkspaceLockManager {
  constructor(private readonly store: HandoffStore = new HandoffStore()) {}

  async acquire(workspacePath: string, handoffId: string, options: AcquireOptions = {}): Promise<AcquireResult> {
    if (!(await isWorkspaceAccessible(workspacePath))) {
      return { acquired: false, reason: `workspace is not accessible: ${workspacePath}`, activitySignal: null };
    }

    const lockKey = await lockKeyFor(workspacePath);
    const freshRecord: WorkspaceLockRecord = {
      lockKey,
      workspacePath,
      holderPid: process.pid,
      holderHandoffId: handoffId,
      holderToken: randomUUID(),
      acquiredAt: Date.now(),
    };

    // Atomic fast path: if this succeeds, nobody else could have won the
    // same race, full stop — no further check can make this case less safe.
    const createdFresh = await this.store.createLockExclusive(freshRecord);
    let recoveredFromCrash = false;
    let overrideUsed = false;

    if (!createdFresh) {
      const existing = await this.store.readLock(lockKey);
      if (existing) {
        const sameHolder = existing.holderPid === process.pid && existing.holderHandoffId === handoffId;
        if (!sameHolder) {
          const holderAlive = isPidAlive(existing.holderPid);
          if (holderAlive && !options.forceOverride) {
            return {
              acquired: false,
              reason: `workspace is locked by a live Relay worker (pid ${existing.holderPid}, handoff ${existing.holderHandoffId})`,
              activitySignal: null,
            };
          }
          if (holderAlive) overrideUsed = true;
          recoveredFromCrash = !holderAlive;
        }
      }
    }

    let activitySignal: ProviderActivitySignal | null = null;
    if (options.checkProviderActivity) {
      activitySignal = await options.checkProviderActivity();
      if (activitySignal.status !== "confirmed_idle") {
        if (!options.forceOverride) {
          return {
            acquired: false,
            reason: `workspace activity could not be confirmed safe (${activitySignal.status}): ${activitySignal.reason}`,
            activitySignal,
          };
        }
        overrideUsed = true;
      }
    }

    if (!createdFresh) await this.store.writeLock(freshRecord); // takeover: either a dead-PID reclaim or an explicit override
    return { acquired: true, overrideUsed, recoveredFromCrash, activitySignal };
  }

  /** Only releases if this process still appears to be the holder — never clears a lock we don't believe is ours. */
  async release(workspacePath: string, handoffId: string): Promise<void> {
    const lockKey = await lockKeyFor(workspacePath);
    const existing = await this.store.readLock(lockKey);
    if (!existing) return;
    if (existing.holderPid !== process.pid || existing.holderHandoffId !== handoffId) return;
    await this.store.deleteLock(lockKey);
  }

  /** Non-mutating inspection: is *this process* currently the recorded holder for this workspace? Used by Phase 3A's ownership model to distinguish "we're already managing this" from "we'd have to newly establish ownership". */
  async isHeldByThisProcess(workspacePath: string): Promise<boolean> {
    const existing = await this.store.readLock(await lockKeyFor(workspacePath));
    return existing?.holderPid === process.pid;
  }

  /**
   * Non-mutating: was the *recorded* lock holder for this workspace a
   * Relay worker whose whole process group has since died? Used by
   * Phase 3B's desktop ownership model (spec condition #3) to recognize
   * "a Relay-managed worker stopped" *before* attempting to acquire the
   * lock, not merely as a side effect of `acquire()`'s own dead-PID
   * reclaim. Returns false when there is no recorded lock at all — that
   * means "nothing to call terminated", not "terminated".
   */
  async wasRelayWorkerThatHasTerminated(workspacePath: string): Promise<boolean> {
    const existing = await this.store.readLock(await lockKeyFor(workspacePath));
    if (!existing) return false;
    return !isPidAlive(existing.holderPid);
  }
}
