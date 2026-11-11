export interface DetectionResult {
  installed: boolean;
  version: string | null;
  detail: string;
}

export type IntegrationChangeKind = "add_hook" | "remove_hook" | "write_file" | "remove_file";

/** A structured, human-readable description of one proposed config edit — printed for approval before anything is written, never raw JSON a user can't review. */
export interface IntegrationChange {
  kind: IntegrationChangeKind;
  filePath: string;
  description: string;
}

export interface ApplyResult {
  applied: IntegrationChange[];
  /** Absolute path of a pre-write backup, one per file actually modified. Empty when there was nothing to change (idempotent no-op). */
  backupPaths: string[];
  /** True when nothing needed to change — requirement #6's idempotency, surfaced explicitly rather than left for the caller to infer from an empty `applied` array. */
  noopAlreadyUpToDate: boolean;
}

export type IntegrationStatusValue = "installed" | "missing" | "broken" | "not_applicable";

export interface IntegrationStatusEntry {
  change: IntegrationChange;
  status: IntegrationStatusValue;
  detail: string;
}

export interface IntegrationStatus {
  id: string;
  detection: DetectionResult;
  entries: IntegrationStatusEntry[];
}

/**
 * Requirement #10's extensible integration-adapter interface. Every
 * method is safe to call repeatedly: `detect()`/`plan()`/`status()` never
 * write anything, and `apply()`/`repair()`/`uninstall()` are all
 * idempotent and back up the file they're about to touch first (see
 * `src/setup/claudeCodeAdapter.ts` for the one real implementation this
 * phase ships, and its own doc comments for exactly how).
 */
export interface IntegrationAdapter {
  readonly id: string;
  detect(): Promise<DetectionResult>;
  plan(): Promise<IntegrationChange[]>;
  apply(): Promise<ApplyResult>;
  status(): Promise<IntegrationStatus>;
  repair(): Promise<ApplyResult>;
  uninstall(): Promise<ApplyResult>;
}
