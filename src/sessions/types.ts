export type SessionProvider = "codex" | "claude";

/**
 * One discovered coding session/thread, as reported by a provider's own
 * documented, read-only interface — never by reading its private
 * credential files or connecting to an undocumented socket. See
 * docs/SESSION_DISCOVERY.md for exactly which interface backs each field,
 * per provider, and its known limitations.
 */
export interface DiscoveredSession {
  provider: SessionProvider;
  sessionId: string;
  /** Working directory the session/thread was started in, when known. */
  projectDir: string | null;
  /** Raw, provider-specific status string (e.g. Claude: "idle"/"busy"; Codex: "idle"/"active"/"systemError"/"notLoaded"). Never normalized away — see docs for why "notLoaded" is not a liveness signal. */
  status: string;
  /** epoch ms of the most recent activity this discovery source reports, when any. */
  lastActivity: number | null;
  /** Which documented interface produced this record, e.g. "claude-cli:agents --json" or "codex-app-server:thread/list". */
  discoverySource: string;
  pid: number | null;
  /** Best-effort human-facing title/name, when the provider exposes one. May describe the task; treat as sensitive when logging/reporting broadly. */
  title: string | null;
  /** Git branch/commit/remote captured by the provider at session-creation time, when it reports one (Codex only, as of this phase). This is the provider's OWN recorded snapshot, not a fresh `git` read. */
  providerGitInfo: { branch: string | null; sha: string | null; originUrl: string | null } | null;
}

export interface WorktreeInfo {
  /** The repository's main worktree root (where `.git` is a real directory), or null if it couldn't be determined. */
  repoRoot: string | null;
  /** When the session's cwd is itself a linked worktree (not the main one), its path; otherwise null. */
  worktreePath: string | null;
}

/**
 * A session, associated with its repository/worktree and annotated with
 * facts about its workspace — never with an inferred "this is the same
 * task as session X" relationship. Two sessions sharing a `repoRoot`
 * remain two separate entries; nothing here merges them.
 */
export interface SessionAssociation extends DiscoveredSession, WorktreeInfo {
  /** false when `projectDir` no longer exists or isn't readable; null when `projectDir` itself is unknown. */
  workspaceAccessible: boolean | null;
}

export interface ProjectGroup {
  /** The repoRoot sessions were grouped by, or null for sessions whose repo root couldn't be determined (grouped together, NOT assumed related to each other). */
  repoRoot: string | null;
  sessions: SessionAssociation[];
}

export interface GitFileStatus {
  path: string;
  /** Raw two-character `git status --porcelain=v1` code, e.g. " M", "??", "A ". */
  code: string;
}

/**
 * A read-only snapshot for a possible handoff. Nothing here is a
 * judgment about whether the task is done — see the fields' own docs.
 */
export interface HandoffSnapshot {
  sourceSessionId: string;
  provider: SessionProvider;
  repoRoot: string | null;
  worktreePath: string | null;
  git: {
    branch: string | null;
    headSha: string | null;
    /** Modified/staged/untracked files from `git status --porcelain=v1`, verbatim. Their mere presence is not evidence of completion or incompletion — see the class-level doc comment on prepareHandoffSnapshot(). */
    files: GitFileStatus[];
  } | null;
  /** The session's own title, when the provider reports one — not a generated summary. */
  availableTaskDescription: string | null;
  /** Whatever structured progress signal the provider itself reports (currently: Codex's thread status/turn count, when present). Null means none was available, not that there was no progress. */
  availableProgressInformation: Record<string, unknown> | null;
  /** Prior validation results (e.g. a saved test run), if this phase's read-only inspection found any. Always null today — nothing produces or stores these yet, and this phase does not run tests itself. */
  validationResults: unknown | null;
  generatedAt: number;
}
