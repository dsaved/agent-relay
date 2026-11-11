import { spawn } from "node:child_process";
import { access, chmod, copyFile, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic, defaultStoreRoot } from "../handoff/store.js";
import { withFileLock } from "./fileLock.js";
import type { ApplyResult, DetectionResult, IntegrationAdapter, IntegrationChange, IntegrationStatus, IntegrationStatusEntry } from "./adapter.js";

/** Reused from Phase 0's own cheap, zero-token CLI-presence check, just factored out so this adapter doesn't depend on `src/claude/usageMonitor.ts` for an unrelated reason. */
export function checkClaudeCliAvailable(): Promise<{ installed: boolean; version: string | null }> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    proc.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    proc.once("error", () => resolve({ installed: false, version: null }));
    proc.once("exit", (code) => resolve({ installed: code === 0, version: code === 0 ? stdout.trim() || null : null }));
  });
}

/**
 * The literal substring every command this adapter ever generates
 * contains — the one signal used to recognize "an entry this tool
 * added," for detection, status, and safe removal alike. Never matched
 * on array position. Deliberately just the subcommand, not a longer
 * phrase like "agent-relay desktop hook-event": the generated command is
 * `"<node path>" "<cli path>" desktop hook-event`, and an absolute path
 * containing "agent-relay" (e.g. `/opt/agent-relay/cli.js`) is quoted
 * and separated from "desktop hook-event" by the rest of the command —
 * never contiguous with it — so a longer marker would never actually
 * match the real generated string.
 */
export const HOOK_MARKER = "desktop hook-event";

/**
 * Requirement #3's "any additional supported events required for useful
 * session tracking": `Stop` (the task-boundary signal this whole
 * integration exists for) plus `SessionEnd` (so the registry also learns
 * when a session itself ends, not only when one turn stops) — a small,
 * fixed list, each installed/removed through the exact same logic, never
 * a special case per event name.
 */
export const MANAGED_HOOK_EVENTS = ["Stop", "SessionEnd"] as const;
export type ManagedHookEvent = (typeof MANAGED_HOOK_EVENTS)[number];

/** Claude Code's own documented per-hook timeout (seconds) — bounds how long it will wait on our command before moving on, so a stuck `desktop hook-event` process can never block or interrupt a real session (requirement: "non-blocking... does not interrupt Claude"). */
export const HOOK_TIMEOUT_SECONDS = 5;

export function defaultClaudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export function defaultSetupLockDir(): string {
  return join(defaultStoreRoot(), "setup-locks");
}

/** Builds the exact command string documented in docs/DESKTOP_INTEGRATION.md §4 — an absolute path to this build's own node binary and `cli.js`, never a bare `agent-relay` that would depend on `PATH` at hook-invocation time (requirement #5). Both paths are shell-quoted since either can contain spaces. */
export function buildHookCommand(nodePath: string, cliPath: string): string {
  return `"${nodePath}" "${cliPath}" desktop hook-event`;
}

interface ClaudeHookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

type ClaudeSettings = Record<string, unknown>;

async function readSettingsFile(path: string): Promise<{ settings: ClaudeSettings; existed: boolean; mode: number | null } | { error: string }> {
  let raw: string;
  let mode: number | null = null;
  try {
    raw = await readFile(path, "utf8");
    mode = (await stat(path)).mode;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, existed: false, mode: null };
    return { error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: `${path} does not contain a JSON object` };
    return { settings: parsed as ClaudeSettings, existed: true, mode };
  } catch (err) {
    // Deliberately NOT defaulted to `{}` here — this file exists and has
    // real content this tool can't parse; proceeding would risk
    // clobbering it. `plan()`/`apply()` surface this as a hard error
    // instead (requirement #3: preserve existing configuration).
    return { error: `${path} exists but is not valid JSON (${err instanceof Error ? err.message : String(err)}) — refusing to modify it` };
  }
}

function eventHooks(settings: ClaudeSettings, event: ManagedHookEvent): ClaudeHookEntry[] {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const arr = hooks?.[event];
  return Array.isArray(arr) ? (arr as ClaudeHookEntry[]) : [];
}

function hasOurHook(settings: ClaudeSettings, event: ManagedHookEvent): boolean {
  return eventHooks(settings, event).some((entry) => entry.hooks?.some((h) => typeof h.command === "string" && h.command.includes(HOOK_MARKER)));
}

/** Adds one new entry for `event` to a deep clone — every other key, every other hook event, every other entry under this same event is passed through completely untouched (requirement #3). */
function withHookAdded(settings: ClaudeSettings, event: ManagedHookEvent, command: string): ClaudeSettings {
  const cloned = structuredClone(settings);
  const hooks = (cloned.hooks ??= {}) as Record<string, unknown>;
  const arr = (hooks[event] ??= []) as ClaudeHookEntry[];
  arr.push({ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] });
  return cloned;
}

/** Removes only entries under `event` that are entirely our own doing (every inner hook's command carries the marker) — an entry a user wrote themselves that happens to also run something else alongside is left alone. */
function withHookRemoved(settings: ClaudeSettings, event: ManagedHookEvent): ClaudeSettings {
  const cloned = structuredClone(settings);
  const hooks = cloned.hooks as Record<string, unknown> | undefined;
  if (!hooks || !Array.isArray(hooks[event])) return cloned;
  hooks[event] = (hooks[event] as ClaudeHookEntry[]).filter((entry) => !(entry.hooks?.length > 0 && entry.hooks.every((h) => typeof h.command === "string" && h.command.includes(HOOK_MARKER))));
  return cloned;
}

/** Requirement #3's "preserve file permissions": backs up (if the file already existed) before writing, then restores the original mode afterward — `writeJsonAtomic`'s plain `writeFile` would otherwise apply this process's umask instead of whatever the user's file already had. */
async function backupThenWrite(path: string, existed: boolean, mode: number | null, next: ClaudeSettings): Promise<string | null> {
  let backupPath: string | null = null;
  if (existed) {
    backupPath = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(path, backupPath); // requirement #4: always back up before modifying an existing file
  }
  await writeJsonAtomic(path, next); // same crash-safe write-temp-then-rename every other record in this project already uses
  if (mode !== null) await chmod(path, mode & 0o777);
  return backupPath;
}

async function commandTargetExists(command: string): Promise<boolean> {
  const match = /^"([^"]+)"/.exec(command);
  if (!match) return false;
  try {
    await access(match[1]!);
    return true;
  } catch {
    return false;
  }
}

export interface ClaudeCodeAdapterOptions {
  settingsPath?: string;
  nodePath?: string;
  cliPath?: string;
  /** Defaults to the real `claude --version` check; tests always inject a fake, same discipline as every other CLI-presence check in this codebase. */
  checkCliAvailable?: () => Promise<{ installed: boolean; version: string | null }>;
  /** Where the per-file edit lock (requirement: concurrent-setup safety) lives; tests always inject a disposable one. */
  lockDir?: string;
}

/**
 * Requirement #2/#3's Claude Code integration: one hook entry per event in
 * `MANAGED_HOOK_EVENTS` in `~/.claude/settings.json` (or an injected path
 * — tests never use the real default), each pointing at this build's own
 * absolute `desktop hook-event` command with a bounded timeout. Every
 * write backs up first and restores the original file mode (requirement
 * #4/permissions), only ever adds to or removes its own, precisely-
 * identified entries (requirement #3), is idempotent (requirement #6),
 * and serializes concurrent callers through a file lock (operational-
 * hardening fix #1) — see the doc comments on
 * `withHookAdded`/`withHookRemoved`/`hasOurHook`/`backupThenWrite` above
 * for exactly how each property holds.
 */
export class ClaudeCodeAdapter implements IntegrationAdapter {
  readonly id = "claude-code";
  private readonly settingsPath: string;
  private readonly command: string;
  private readonly checkCliAvailable: () => Promise<{ installed: boolean; version: string | null }>;
  private readonly lockDir: string;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.settingsPath = options.settingsPath ?? defaultClaudeSettingsPath();
    this.command = buildHookCommand(options.nodePath ?? process.execPath, options.cliPath ?? process.argv[1] ?? "agent-relay");
    this.checkCliAvailable = options.checkCliAvailable ?? checkClaudeCliAvailable;
    this.lockDir = options.lockDir ?? defaultSetupLockDir();
  }

  async detect(): Promise<DetectionResult> {
    const { installed, version } = await this.checkCliAvailable();
    return { installed, version, detail: installed ? `claude CLI found (${version ?? "version unknown"})` : "claude CLI was not found on PATH (checked via `claude --version`)" };
  }

  private describe(event: ManagedHookEvent, verb: "Add" | "Added" | "Removed" | "describe"): IntegrationChange {
    const prefix = verb === "describe" ? `${event} hook in` : `${verb} a ${event} hook to`;
    return { kind: verb === "Removed" ? "remove_hook" : "add_hook", filePath: this.settingsPath, description: `${prefix} ${this.settingsPath} running: ${this.command}` };
  }

  async plan(): Promise<IntegrationChange[]> {
    const read = await readSettingsFile(this.settingsPath);
    if ("error" in read) throw new Error(read.error);
    return MANAGED_HOOK_EVENTS.filter((event) => !hasOurHook(read.settings, event)).map((event) => this.describe(event, "Add"));
  }

  async apply(): Promise<ApplyResult> {
    return withFileLock(this.settingsPath, this.lockDir, async () => {
      const read = await readSettingsFile(this.settingsPath);
      if ("error" in read) throw new Error(read.error);

      const missing = MANAGED_HOOK_EVENTS.filter((event) => !hasOurHook(read.settings, event));
      if (missing.length === 0) return { applied: [], backupPaths: [], noopAlreadyUpToDate: true };

      let next = read.settings;
      for (const event of missing) next = withHookAdded(next, event, this.command);
      const backupPath = await backupThenWrite(this.settingsPath, read.existed, read.mode, next);
      return { applied: missing.map((event) => this.describe(event, "Added")), backupPaths: backupPath ? [backupPath] : [], noopAlreadyUpToDate: false };
    });
  }

  async status(): Promise<IntegrationStatus> {
    const detection = await this.detect();
    const read = await readSettingsFile(this.settingsPath);
    const entries: IntegrationStatusEntry[] = [];

    for (const event of MANAGED_HOOK_EVENTS) {
      const describedChange = this.describe(event, "describe");
      if ("error" in read) {
        entries.push({ change: describedChange, status: "broken", detail: read.error });
        continue;
      }
      if (!hasOurHook(read.settings, event)) {
        entries.push({ change: describedChange, status: "missing", detail: `no matching ${event} hook found` });
        continue;
      }
      const ourEntry = eventHooks(read.settings, event).find((entry) => entry.hooks?.some((h) => h.command.includes(HOOK_MARKER)));
      const ourCommand = ourEntry?.hooks.find((h) => h.command.includes(HOOK_MARKER))?.command ?? "";
      const targetExists = await commandTargetExists(ourCommand);
      entries.push(
        targetExists
          ? { change: describedChange, status: "installed", detail: "present and the referenced executable exists" }
          : { change: describedChange, status: "broken", detail: `hook is present but its command's executable no longer exists: ${ourCommand}` },
      );
    }
    return { id: this.id, detection, entries };
  }

  /** Re-plans and re-applies only the gap — any event already `status()`-"installed" is left alone, same idempotent `apply()` underneath, never a blind full re-write. */
  async repair(): Promise<ApplyResult> {
    return this.apply();
  }

  async uninstall(): Promise<ApplyResult> {
    return withFileLock(this.settingsPath, this.lockDir, async () => {
      const read = await readSettingsFile(this.settingsPath);
      if ("error" in read) throw new Error(read.error);

      const present = MANAGED_HOOK_EVENTS.filter((event) => read.existed && hasOurHook(read.settings, event));
      if (present.length === 0) return { applied: [], backupPaths: [], noopAlreadyUpToDate: true };

      let next = read.settings;
      for (const event of present) next = withHookRemoved(next, event);
      const backupPath = await backupThenWrite(this.settingsPath, read.existed, read.mode, next);
      return { applied: present.map((event) => this.describe(event, "Removed")), backupPaths: backupPath ? [backupPath] : [], noopAlreadyUpToDate: false };
    });
  }
}
