import type { SessionProvider } from "../sessions/types.js";
import type { ActivityStatus } from "../handoff/lock.js";

/**
 * Phase 3B's workspace-ownership lifecycle for desktop-originated
 * sessions. Deliberately a separate type from `../auto/types.js`'s
 * `OwnershipState` (Phase 3A) rather than a rename/extension of it —
 * Phase 3A's 3-state model governs the *existing*, already-verified
 * leg-to-leg bounce inside `AutomaticHandoffCoordinator` (requirement:
 * "preserve all Phase 0-3A functionality"); this 7-state model governs
 * only the new desktop-registration-and-handoff path. See
 * docs/DESKTOP_INTEGRATION.md §2.
 */
export type DesktopOwnershipState =
  | "external_unmanaged" // no Relay history, no confirmed external activity either
  | "external_active" // a desktop session is confirmed actively running
  | "external_unknown" // liveness can't be confirmed (e.g. ordinary Codex thread history)
  | "handoff_requested" // a user explicitly authorized transfer; evidence being (re)checked
  | "relinquished" // Relay held it, then external activity reappeared before/without a clean release
  | "relay_owned" // this process holds the workspace lock right now
  | "released"; // Relay finished and let go cleanly; the next check starts fresh, not from this label

export interface DesktopEvidenceEntry {
  at: number;
  source: string;
  detail: string;
}

/**
 * One registered desktop-originated session. Never merged with another
 * session just because it shares a `repoRoot` (same rule as
 * `projectAssociation.ts`'s `groupByProject`) — each gets its own record.
 */
export interface DesktopSessionRecord {
  provider: SessionProvider;
  sessionId: string;
  repoRoot: string | null;
  worktreePath: string | null;
  /** e.g. "Codex Desktop", "Claude Desktop (Code tab)", "Codex CLI", "Claude Code CLI" — best-effort, see registry.ts. */
  originatingApp: string;
  objective: string;
  observedActivity: ActivityStatus;
  lastConfirmedActivityAt: number | null;
  associatedTaskId: string | null;
  ownershipStatus: DesktopOwnershipState;
  /** Append-only audit trail — registration, hook events, ownership re-checks, handoff attempts. Never rewritten, only appended to. */
  evidence: DesktopEvidenceEntry[];
  registeredAt: number;
  updatedAt: number;
}

/**
 * The subset of a Claude Code hook's stdin JSON payload this phase reads.
 * Hooks are configured by the user in their own `~/.claude/settings.json`
 * (this phase never writes that file — see docs/DESKTOP_INTEGRATION.md
 * §4) and invoke a shell command with this JSON on stdin for events like
 * SessionStart/Stop/SubagentStop/Notification/PreToolUse/PostToolUse.
 */
export interface HookEventPayload {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  [key: string]: unknown;
}
