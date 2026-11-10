import { DesktopRegistry } from "../desktop/registry.js";
import type { DaemonLogger } from "./log.js";

/**
 * Requirement #7: periodically refreshes registered desktop sessions'
 * activity using exactly the existing `DesktopRegistry.refreshOwnership`
 * (Phase 3B, unchanged) — never with `authorizeNow: true` (a poll is
 * never itself an authorization to take ownership), never touching an
 * undocumented desktop IPC interface, and never treating a session's
 * `relay_owned` status specially beyond simply not needing to re-poll
 * what this daemon itself already holds. Usage-monitor correlation
 * (Codex/Claude) is already built into `DesktopRegistry`/Phase 3B's own
 * `usage codex`/`usage claude` commands — this loop does not duplicate
 * that, it only keeps `observedActivity` current.
 */
export class DesktopMonitor {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly registry: DesktopRegistry,
    private readonly intervalMs: number,
    private readonly logger?: DaemonLogger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    const records = await this.registry.list();
    for (const record of records) {
      if (record.ownershipStatus === "relay_owned") continue; // nothing to learn by polling what this daemon already holds
      try {
        const { record: refreshed } = await this.registry.refreshOwnership(record.sessionId, false);
        if (refreshed.ownershipStatus === "external_unknown" && refreshed.associatedTaskId) {
          await this.logger?.write("approval_required", { sessionId: refreshed.sessionId, taskId: refreshed.associatedTaskId, reason: "ownership could not be verified by this poll" });
        } else {
          await this.logger?.write("workspace_ownership", { sessionId: refreshed.sessionId, ownershipStatus: refreshed.ownershipStatus });
        }
      } catch (err) {
        await this.logger?.write("workspace_ownership", { sessionId: record.sessionId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
