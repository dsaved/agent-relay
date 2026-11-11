#!/usr/bin/env node
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { CodexUsageMonitor } from "./codex/usageMonitor.js";
import { formatCodexUsageStatus } from "./codex/formatUsage.js";
import { ClaudeUsageMonitor } from "./claude/usageMonitor.js";
import { formatClaudeUsageStatus } from "./claude/formatUsage.js";
import { CopilotUsageMonitor } from "./copilot/usageMonitor.js";
import { formatCopilotUsageStatus } from "./copilot/formatUsage.js";
import type { UsageSnapshot } from "./usage/types.js";
import { discoverAllSessions } from "./sessions/discoverAll.js";
import { detectWorktreeInfo } from "./sessions/projectAssociation.js";
import { prepareHandoffSnapshot } from "./sessions/handoff.js";
import { formatSessionLine, formatHandoffSnapshot } from "./sessions/format.js";
import type { SessionProvider } from "./sessions/types.js";
import { HandoffStore, defaultStoreRoot } from "./handoff/store.js";
import { createHandoffRecord } from "./handoff/prepare.js";
import { HandoffEngine } from "./handoff/engine.js";
import { formatHandoffRecord, formatTask } from "./handoff/format.js";
import { AutomaticHandoffCoordinator } from "./auto/coordinator.js";
import { formatAutoTaskState, formatAutoHistory } from "./auto/format.js";
import { DesktopRegistry, parseHookEvent } from "./desktop/registry.js";
import { requestDesktopHandoff } from "./desktop/handoff.js";
import { formatDesktopSession } from "./desktop/format.js";
import { callDaemon, pingDaemon, DaemonUnreachableError } from "./daemon/client.js";
import { defaultSocketPath, runForeground } from "./daemon/process.js";
import { generateLaunchdPlist, plistPath, launchAgentsDir, DEFAULT_LAUNCHD_LABEL, activate as launchdActivate, deactivate as launchdDeactivate, isLoaded as launchdIsLoaded } from "./daemon/launchd.js";
import { logPath, redact } from "./daemon/log.js";
import { loadConfig, validateConfig } from "./daemon/config.js";
import {
  defaultAdapters,
  planSetup,
  applySetup,
  statusAll,
  repairAll,
  uninstallAll,
  formatSetupPlan,
  formatApplyOutcomes,
  formatStatusAll,
  formatRepairOutcomes,
  formatUninstallOutcomes,
  checkSetupPrerequisites,
  formatSetupPrerequisites,
} from "./setup/run.js";
import type { AutoTaskState } from "./auto/types.js";
import type { SubmitResult } from "./daemon/scheduler.js";

async function codexStatus(): Promise<{ text: string; exitCode: number }> {
  const monitor = new CodexUsageMonitor();
  try {
    const status = await monitor.getStatus();
    return { text: formatCodexUsageStatus(status), exitCode: status.error ? 1 : 0 };
  } finally {
    await monitor.close();
  }
}

/**
 * `agent-relay usage claude` has nothing to observe on its own — Claude
 * has no zero-turn usage endpoint (see docs/FEASIBILITY.md Phase 1B), so
 * this monitor only knows what a real session's stream-json output tells
 * it. If stdin is piped (e.g. from `claude -p ... --output-format
 * stream-json`), feed those lines in first; run with no piped input and
 * it correctly reports "unknown — never observed" rather than guessing.
 */
async function claudeStatus(): Promise<{ text: string; exitCode: number }> {
  const monitor = new ClaudeUsageMonitor();
  try {
    if (!process.stdin.isTTY) {
      await new Promise<void>((resolve) => {
        const rl = createInterface({ input: process.stdin });
        rl.on("line", (line) => monitor.observeLine(line));
        rl.on("close", resolve);
      });
    }
    const status: UsageSnapshot = await monitor.getStatus();
    return { text: formatClaudeUsageStatus(status), exitCode: status.error ? 1 : 0 };
  } finally {
    await monitor.close();
  }
}

/** Same passive-only shape as `claudeStatus` — see src/copilot/usageMonitor.ts on why, and that Copilot's usage-signal field is unverified. */
async function copilotStatus(): Promise<{ text: string; exitCode: number }> {
  const monitor = new CopilotUsageMonitor();
  try {
    if (!process.stdin.isTTY) {
      await new Promise<void>((resolve) => {
        const rl = createInterface({ input: process.stdin });
        rl.on("line", (line) => monitor.observeLine(line));
        rl.on("close", resolve);
      });
    }
    const status: UsageSnapshot = await monitor.getStatus();
    return { text: formatCopilotUsageStatus(status), exitCode: status.error ? 1 : 0 };
  } finally {
    await monitor.close();
  }
}

function parseFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function parseAllFlags(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1] !== undefined) values.push(args[i + 1] as string);
  }
  return values;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Everything here is read-only in this phase: discovery, association, and the handoff snapshot never write to a repo or start a session. */
async function sessionsCommand(args: string[]): Promise<{ text: string; exitCode: number }> {
  const providerFlag = parseFlag(args, "--provider");
  const projectFlag = parseFlag(args, "--project");
  if (providerFlag && providerFlag !== "claude" && providerFlag !== "codex" && providerFlag !== "copilot") {
    return { text: `Unknown --provider "${providerFlag}" (expected "claude", "codex", or "copilot")`, exitCode: 1 };
  }
  const providers: SessionProvider[] = providerFlag ? [providerFlag as SessionProvider] : ["codex", "claude"];

  const { sessions, errors } = await discoverAllSessions(providers);
  let filtered = sessions;
  if (projectFlag) {
    const target = await detectWorktreeInfo(projectFlag);
    const targetRoot = target.repoRoot ?? projectFlag;
    filtered = sessions.filter((s) => s.repoRoot === targetRoot || s.projectDir === projectFlag);
  }

  const lines: string[] = [];
  if (filtered.length === 0) {
    lines.push("No sessions discovered.");
  } else {
    lines.push(`${filtered.length} session(s) discovered:`, "");
    filtered.forEach((s, i) => {
      if (i > 0) lines.push("");
      lines.push(formatSessionLine(s));
    });
  }
  for (const e of errors) lines.push("", `[${e.provider}] discovery error: ${e.message}`);

  return { text: lines.join("\n"), exitCode: filtered.length === 0 && errors.length > 0 ? 1 : 0 };
}

async function inspectCommand(sessionId: string | undefined): Promise<{ text: string; exitCode: number }> {
  if (!sessionId) return { text: "Usage: agent-relay inspect <session-id>", exitCode: 1 };
  const { sessions } = await discoverAllSessions();
  const match = sessions.find((s) => s.sessionId === sessionId);
  if (!match) {
    return { text: `No session with id "${sessionId}" found among ${sessions.length} discovered session(s).`, exitCode: 1 };
  }
  return { text: formatSessionLine(match), exitCode: 0 };
}

/**
 * Read-only with respect to the discovered session's own repository: it
 * runs the same three `git` reads Phase 2A's snapshot always did, and
 * never spawns an agent or takes a workspace lock. The only thing new
 * here is persisting the result as a durable, ID-addressable record in
 * this tool's own `~/.agent-relay` store, so `handoff execute` has
 * something to act on later.
 */
async function handoffPrepareCommand(args: string[]): Promise<{ text: string; exitCode: number }> {
  const sessionId = args[0];
  if (!sessionId) return { text: "Usage: agent-relay handoff prepare <session-id> [--reason \"...\"]", exitCode: 1 };
  const { sessions } = await discoverAllSessions();
  const match = sessions.find((s) => s.sessionId === sessionId);
  if (!match) {
    return { text: `No session with id "${sessionId}" found among ${sessions.length} discovered session(s).`, exitCode: 1 };
  }
  const snapshot = await prepareHandoffSnapshot(match);
  const { task, handoff } = await createHandoffRecord(match, { handoffReason: parseFlag(args, "--reason") ?? null });

  const store = new HandoffStore();
  await store.saveTask(task);
  await store.saveHandoff(handoff);

  return {
    text: [formatHandoffSnapshot(snapshot), "", `Persisted as handoff ${handoff.handoffId} (task ${task.taskId}).`].join("\n"),
    exitCode: 0,
  };
}

async function handoffExecuteCommand(args: string[]): Promise<{ text: string; exitCode: number }> {
  const handoffId = args[0];
  const to = parseFlag(args, "--to");
  if (!handoffId || !to) return { text: "Usage: agent-relay handoff execute <handoff-id> --to <claude|codex> [--objective \"...\"] [--force-lock] [--validate \"cmd\"]...", exitCode: 1 };
  if (to !== "claude" && to !== "codex") return { text: `Unknown --to "${to}" (expected "claude" or "codex")`, exitCode: 1 };

  const engine = new HandoffEngine();
  try {
    const result = await engine.executeHandoff(handoffId, {
      to,
      suppliedObjective: parseFlag(args, "--objective"),
      forceLockOverride: hasFlag(args, "--force-lock"),
      validationCommands: parseAllFlags(args, "--validate"),
      timeoutMs: parseFlag(args, "--timeout-ms") ? Number(parseFlag(args, "--timeout-ms")) : undefined,
    });
    const lines = [formatHandoffRecord(result.handoff)];
    if (result.blockedReason) lines.push("", `Blocked: ${result.blockedReason}`);
    return { text: lines.join("\n"), exitCode: result.handoff.status === "completed" ? 0 : 1 };
  } catch (err) {
    return { text: `agent-relay: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
  }
}

async function handoffStatusCommand(handoffId: string | undefined): Promise<{ text: string; exitCode: number }> {
  if (!handoffId) return { text: "Usage: agent-relay handoff status <handoff-id>", exitCode: 1 };
  const store = new HandoffStore();
  const handoff = await store.loadHandoff(handoffId);
  if (!handoff) return { text: `No handoff found with id "${handoffId}".`, exitCode: 1 };
  return { text: formatHandoffRecord(handoff), exitCode: 0 };
}

async function tasksCommand(): Promise<{ text: string; exitCode: number }> {
  const store = new HandoffStore();
  const taskIds = await store.listTaskIds();
  if (taskIds.length === 0) return { text: "No tasks recorded.", exitCode: 0 };
  const lines: string[] = [];
  for (const taskId of taskIds) {
    const task = await store.loadTask(taskId);
    if (!task) continue;
    const handoffs = (await Promise.all(task.handoffIds.map((id) => store.loadHandoff(id)))).filter((h): h is NonNullable<typeof h> => h !== null);
    if (lines.length > 0) lines.push("");
    lines.push(formatTask(task, handoffs));
  }
  return { text: lines.join("\n"), exitCode: 0 };
}

async function taskInspectCommand(taskId: string | undefined): Promise<{ text: string; exitCode: number }> {
  if (!taskId) return { text: "Usage: agent-relay task inspect <task-id>", exitCode: 1 };
  const store = new HandoffStore();
  const task = await store.loadTask(taskId);
  if (!task) return { text: `No task found with id "${taskId}".`, exitCode: 1 };
  const handoffs = (await Promise.all(task.handoffIds.map((id) => store.loadHandoff(id)))).filter((h): h is NonNullable<typeof h> => h !== null);
  const lines = [formatTask(task, handoffs), ""];
  for (const h of handoffs) lines.push(formatHandoffRecord(h), "");
  return { text: lines.join("\n").trimEnd(), exitCode: 0 };
}

function exitCodeForAutoState(stateName: string): number {
  return stateName === "completed" ? 0 : 1;
}

/**
 * Phase 4 requirement #4: if a daemon is reachable, every `auto` command
 * that can mutate state goes through it instead of running
 * `AutomaticHandoffCoordinator` directly in this short-lived CLI process.
 * `DaemonUnreachableError` (no socket / stale socket — see
 * src/daemon/client.ts) is the ONLY case that falls back to Phase 3A's
 * original, unchanged, direct/blocking behavior below — a command the
 * daemon genuinely rejected (`DaemonCommandError`) or didn't answer in
 * time (`DaemonTimeoutError`) is a real failure, not "no daemon running".
 */
async function callDaemonIfRunning(command: string, args: unknown): Promise<{ reachable: true; result: unknown } | { reachable: false }> {
  try {
    // `autoPause`/`autoStop` can legitimately take as long as `spawnRun`'s
    // own SIGTERM-then-SIGKILL grace period (src/execution/spawnRun.ts) if
    // something is genuinely in flight when asked to stop — this timeout
    // must comfortably exceed that, not just a typical quick round trip.
    const result = await callDaemon(defaultSocketPath(defaultStoreRoot()), command, args, { timeoutMs: 15_000 });
    return { reachable: true, result };
  } catch (err) {
    if (err instanceof DaemonUnreachableError) return { reachable: false };
    throw err;
  }
}

function formatSubmitResult(submit: SubmitResult): string {
  const lines = [formatAutoTaskState(submit.state)];
  lines.push("", submit.running ? "Accepted by the daemon and durably recorded — running in the background; use `auto status`/`auto history` to check progress." : "Already settled — nothing new was started.");
  return lines.join("\n");
}

/**
 * Without a daemon, this runs in the foreground exactly as Phase 3A
 * always has — it drives the coordinator's loop to completion/pause/
 * failure and exits. With a daemon running, it instead submits the task
 * and returns as soon as the daemon has durably recorded it — never
 * presenting that acceptance as completion (requirement #4).
 */
async function autoStartCommand(args: string[]): Promise<{ text: string; exitCode: number }> {
  const taskId = args[0];
  if (!taskId) return { text: "Usage: agent-relay auto start <task-id> [--objective \"...\"] [--validate \"cmd\"]... [--allow-unknown-availability] [--max-handoffs N] [--max-attempts N] [--max-runtime-ms N] [--pin <claude|codex>]", exitCode: 1 };

  const pin = parseFlag(args, "--pin");
  if (pin && pin !== "claude" && pin !== "codex") return { text: `Unknown --pin "${pin}" (expected "claude" or "codex")`, exitCode: 1 };
  const options = {
    suppliedObjective: parseFlag(args, "--objective"),
    validationCommands: parseAllFlags(args, "--validate"),
    allowUnknownAvailability: hasFlag(args, "--allow-unknown-availability"),
    maxHandoffs: parseFlag(args, "--max-handoffs") ? Number(parseFlag(args, "--max-handoffs")) : undefined,
    maxAttempts: parseFlag(args, "--max-attempts") ? Number(parseFlag(args, "--max-attempts")) : undefined,
    maxRuntimeMs: parseFlag(args, "--max-runtime-ms") ? Number(parseFlag(args, "--max-runtime-ms")) : undefined,
    pinnedProvider: pin as "claude" | "codex" | undefined,
  };

  try {
    const viaDaemon = await callDaemonIfRunning("autoStart", { taskId, options });
    if (viaDaemon.reachable) return { text: formatSubmitResult(viaDaemon.result as SubmitResult), exitCode: 0 };

    const state = await new AutomaticHandoffCoordinator().start(taskId, options);
    return { text: formatAutoTaskState(state), exitCode: exitCodeForAutoState(state.state) };
  } catch (err) {
    return { text: `agent-relay: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
  }
}

/** Pure read — reads the store directly whether or not a daemon is running, since there's nothing to round-trip for a read-only status check. */
async function autoStatusCommand(taskId: string | undefined): Promise<{ text: string; exitCode: number }> {
  if (!taskId) return { text: "Usage: agent-relay auto status <task-id>", exitCode: 1 };
  const state = await new AutomaticHandoffCoordinator().status(taskId);
  if (!state) return { text: `No automatic task state found for "${taskId}".`, exitCode: 1 };
  return { text: formatAutoTaskState(state), exitCode: 0 };
}

/**
 * With a daemon running and this task genuinely executing there, this
 * reaches the real in-flight `AbortController` (requirement #5 — pause
 * actually interrupts an in-flight run, not just a state file). Without
 * one, falls back to Phase 3A's original direct store mutation,
 * unchanged.
 */
async function autoPauseCommand(taskId: string | undefined): Promise<{ text: string; exitCode: number }> {
  if (!taskId) return { text: "Usage: agent-relay auto pause <task-id>", exitCode: 1 };
  try {
    const viaDaemon = await callDaemonIfRunning("autoPause", { taskId });
    const state = viaDaemon.reachable ? (viaDaemon.result as AutoTaskState) : await new AutomaticHandoffCoordinator().pause(taskId);
    return { text: formatAutoTaskState(state), exitCode: 0 };
  } catch (err) {
    return { text: `agent-relay: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
  }
}

async function autoResumeCommand(args: string[]): Promise<{ text: string; exitCode: number }> {
  const taskId = args[0];
  if (!taskId) return { text: "Usage: agent-relay auto resume <task-id> [--objective \"...\"]", exitCode: 1 };
  const suppliedObjective = parseFlag(args, "--objective");
  try {
    const viaDaemon = await callDaemonIfRunning("autoResume", { taskId, suppliedObjective });
    if (viaDaemon.reachable) return { text: formatSubmitResult(viaDaemon.result as SubmitResult), exitCode: 0 };

    const state = await new AutomaticHandoffCoordinator().resume(taskId, { suppliedObjective });
    return { text: formatAutoTaskState(state), exitCode: exitCodeForAutoState(state.state) };
  } catch (err) {
    return { text: `agent-relay: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
  }
}

/** Same daemon-first/direct-fallback split as `autoPauseCommand` — see its doc comment. */
async function autoStopCommand(taskId: string | undefined): Promise<{ text: string; exitCode: number }> {
  if (!taskId) return { text: "Usage: agent-relay auto stop <task-id>", exitCode: 1 };
  try {
    const viaDaemon = await callDaemonIfRunning("autoStop", { taskId });
    const state = viaDaemon.reachable ? (viaDaemon.result as AutoTaskState) : await new AutomaticHandoffCoordinator().stop(taskId);
    return { text: formatAutoTaskState(state), exitCode: 0 };
  } catch (err) {
    return { text: `agent-relay: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
  }
}

async function autoHistoryCommand(taskId: string | undefined): Promise<{ text: string; exitCode: number }> {
  if (!taskId) return { text: "Usage: agent-relay auto history <task-id>", exitCode: 1 };
  const coordinator = new AutomaticHandoffCoordinator();
  const state = await coordinator.status(taskId);
  if (!state) return { text: `No automatic task state found for "${taskId}".`, exitCode: 1 };
  return { text: formatAutoHistory(state.transitions), exitCode: 0 };
}

/** Requirement #5's desktop task registration/inspection commands — all read/write only to this tool's own `~/.agent-relay` store, never to the discovered session's repository beyond what `ensureTask` already does via `createHandoffRecord`. */
async function desktopRegisterCommand(args: string[]): Promise<{ text: string; exitCode: number }> {
  const sessionId = args[0];
  if (!sessionId) return { text: 'Usage: agent-relay desktop register <session-id> --objective "..."', exitCode: 1 };
  try {
    const record = await new DesktopRegistry().register(sessionId, parseFlag(args, "--objective"));
    return { text: formatDesktopSession(record), exitCode: 0 };
  } catch (err) {
    return { text: `agent-relay: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
  }
}

async function desktopSessionsCommand(): Promise<{ text: string; exitCode: number }> {
  const records = await new DesktopRegistry().list();
  if (records.length === 0) return { text: "No desktop sessions registered.", exitCode: 0 };
  return { text: records.map(formatDesktopSession).join("\n\n"), exitCode: 0 };
}

async function desktopInspectCommand(sessionId: string | undefined): Promise<{ text: string; exitCode: number }> {
  if (!sessionId) return { text: "Usage: agent-relay desktop inspect <session-id>", exitCode: 1 };
  const record = await new DesktopRegistry().get(sessionId);
  if (!record) return { text: `No registered desktop session with id "${sessionId}".`, exitCode: 1 };
  return { text: formatDesktopSession(record), exitCode: 0 };
}

async function desktopHandoffCommand(args: string[]): Promise<{ text: string; exitCode: number }> {
  const sessionId = args[0];
  const to = parseFlag(args, "--to");
  if (!sessionId || !to) return { text: "Usage: agent-relay desktop handoff <session-id> --to <claude|codex> [--force-lock] [--validate \"cmd\"]...", exitCode: 1 };
  if (to !== "claude" && to !== "codex") return { text: `Unknown --to "${to}" (expected "claude" or "codex")`, exitCode: 1 };

  try {
    const result = await requestDesktopHandoff(sessionId, {
      to,
      forceLockOverride: hasFlag(args, "--force-lock"),
      validationCommands: parseAllFlags(args, "--validate"),
    });
    const lines = [formatDesktopSession(result.record)];
    if (result.blockedReason) lines.push("", `Blocked: ${result.blockedReason}`);
    else if (result.handoffId) lines.push("", `Handoff executed: ${result.handoffId} (task ${result.taskId}) — see \`agent-relay handoff status ${result.handoffId}\` for the full attempt record.`);
    return { text: lines.join("\n"), exitCode: result.blockedReason ? 1 : 0 };
  } catch (err) {
    return { text: `agent-relay: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
  }
}

/** Reads one JSON hook payload per line from stdin (a Claude Code hook's own stdin shape — see docs/DESKTOP_INTEGRATION.md §4) and appends evidence to the matching registered session. Never spawns a model call; a session that was never registered is reported, not an error. */
async function desktopHookEventCommand(): Promise<{ text: string; exitCode: number }> {
  const registry = new DesktopRegistry();
  const rawLines: string[] = [];
  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => rawLines.push(line));
    rl.on("close", resolve);
  });

  const lines: string[] = [];
  let sawError = false;
  for (const line of rawLines) {
    if (!line.trim()) continue;
    const parsed = parseHookEvent(line);
    if ("error" in parsed) {
      lines.push(`error: ${parsed.error}`);
      sawError = true;
      continue;
    }
    const updated = await registry.recordEvidence(parsed.payload.session_id, `claude-code-hook:${parsed.payload.hook_event_name}`, JSON.stringify(parsed.payload));
    lines.push(updated ? `recorded ${parsed.payload.hook_event_name} for ${parsed.payload.session_id}` : `${parsed.payload.hook_event_name} for unregistered session ${parsed.payload.session_id} (ignored)`);
  }
  return { text: lines.length > 0 ? lines.join("\n") : "No hook events received on stdin.", exitCode: sawError ? 1 : 0 };
}

/** The absolute path to this very file, as built — what both `daemon start` (spawning a background process) and `daemon install`'s generated plist (as its `ProgramArguments`) point `node` at. */
function resolveCliPath(): string {
  return fileURLToPath(import.meta.url);
}

async function daemonPingStatus(): Promise<{ pid: number; uptimeMs: number; version: string } | null> {
  return pingDaemon(defaultSocketPath(defaultStoreRoot()));
}

/**
 * Requirement #2: writes the plist file only — it never calls
 * `launchctl load`/`bootstrap` itself. Loading/activating a launchd
 * service is a standing, persistent-configuration change on your system,
 * which this session's own rules (and the task's own "do not
 * automatically install or activate the service during development")
 * require asking you about separately; this command prints the exact
 * command to run instead of running it.
 */
async function daemonInstallCommand(): Promise<{ text: string; exitCode: number }> {
  const stateDir = defaultStoreRoot();
  const plist = generateLaunchdPlist({ nodePath: process.execPath, cliPath: resolveCliPath(), stateDir });
  const path = plistPath();
  await mkdir(launchAgentsDir(), { recursive: true });
  await writeFile(path, plist);
  return {
    text: [`Wrote ${path}.`, "", "This does NOT load or activate the service — run `agent-relay daemon activate` yourself when you're ready."].join("\n"),
    exitCode: 0,
  };
}

async function daemonUninstallCommand(): Promise<{ text: string; exitCode: number }> {
  const path = plistPath();
  await rm(path, { force: true });
  return {
    text: [`Removed ${path} (if it existed).`, "", "If the service was loaded, unload it first (or after) with `agent-relay daemon deactivate`."].join("\n"),
    exitCode: 0,
  };
}

/**
 * Spawns the daemon as a detached background process — independent of
 * this terminal session, per requirement #1. Refuses if one is already
 * running for this state directory (the daemon's own single-instance
 * guard would refuse too; checking here just gives a clearer message).
 *
 * Single-lifecycle-owner check (requirement #5): also refuses if launchd
 * already has this service loaded — that instance's `KeepAlive` means
 * launchd itself is the one responsible for keeping it running, and
 * racing a second, manually-started process against that is exactly
 * what this check exists to prevent. `daemon activate`/`restart` are the
 * right commands once launchd owns it.
 */
async function daemonStartCommand(): Promise<{ text: string; exitCode: number }> {
  const existing = await daemonPingStatus();
  if (existing) return { text: `Already running (pid ${existing.pid}, up ${Math.round(existing.uptimeMs / 1000)}s).`, exitCode: 0 };

  if (await launchdIsLoaded(DEFAULT_LAUNCHD_LABEL)) {
    return { text: "agent-relay: launchd already manages this daemon (it is loaded, though not currently answering — it may be between restarts). Use `daemon restart` or `launchctl kickstart`, not `daemon start`, to avoid two lifecycle owners for the same state directory.", exitCode: 1 };
  }

  const child = spawn(process.execPath, [resolveCliPath(), "daemon", "run-foreground"], { detached: true, stdio: "ignore" });
  child.unref();

  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const started = await daemonPingStatus();
    if (started) return { text: `Daemon started (pid ${started.pid}).`, exitCode: 0 };
  }
  return { text: "agent-relay: daemon did not respond after starting — check `agent-relay daemon logs`.", exitCode: 1 };
}

async function daemonStopCommand(): Promise<{ text: string; exitCode: number }> {
  const existing = await daemonPingStatus();
  if (!existing) return { text: "Not running.", exitCode: 0 };
  try {
    await callDaemon(defaultSocketPath(defaultStoreRoot()), "shutdown", {});
  } catch {
    // The connection itself may drop as part of shutdown — that's expected, not a failure to report.
  }
  return { text: `Stop requested (was pid ${existing.pid}).`, exitCode: 0 };
}

async function daemonRestartCommand(): Promise<{ text: string; exitCode: number }> {
  const stopResult = await daemonStopCommand();
  if (stopResult.exitCode !== 0) return stopResult;
  await new Promise((resolve) => setTimeout(resolve, 500));
  return daemonStartCommand();
}

async function daemonStatusCommand(): Promise<{ text: string; exitCode: number }> {
  const stateDir = defaultStoreRoot();
  const existing = await daemonPingStatus();
  const lines = [
    existing ? `Running (pid ${existing.pid}, up ${Math.round(existing.uptimeMs / 1000)}s).` : "Not running.",
    `state directory: ${stateDir}`,
    `socket: ${defaultSocketPath(stateDir)}`,
  ];
  try {
    await readFile(plistPath(), "utf8");
    const loaded = await launchdIsLoaded(DEFAULT_LAUNCHD_LABEL);
    lines.push(`launchd plist installed at: ${plistPath()} (${loaded ? "loaded — launchd is the lifecycle owner" : "not currently loaded — run `daemon activate` to load it"})`);
  } catch {
    lines.push("launchd plist: not installed (`agent-relay daemon install` to generate one)");
  }
  return { text: lines.join("\n"), exitCode: existing ? 0 : 1 };
}

/** Requirement #5: idempotent — a no-op (reported, not an error) when already loaded. Never called automatically by this session against the real system; only ever invoked when the user runs this command themselves after approving `setup`. */
async function daemonActivateCommand(): Promise<{ text: string; exitCode: number }> {
  try {
    await readFile(plistPath(), "utf8");
  } catch {
    return { text: "agent-relay: no plist installed yet — run `agent-relay daemon install` (or `setup`) first.", exitCode: 1 };
  }
  try {
    const result = await launchdActivate(plistPath(), DEFAULT_LAUNCHD_LABEL);
    return { text: result.detail, exitCode: 0 };
  } catch (err) {
    return { text: `agent-relay: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
  }
}

async function daemonDeactivateCommand(): Promise<{ text: string; exitCode: number }> {
  try {
    const result = await launchdDeactivate(DEFAULT_LAUNCHD_LABEL);
    return { text: result.detail, exitCode: 0 };
  } catch (err) {
    return { text: `agent-relay: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
  }
}

async function daemonLogsCommand(args: string[]): Promise<{ text: string; exitCode: number }> {
  const stateDir = defaultStoreRoot();
  const dateFlag = parseFlag(args, "--date");
  const path = logPath(stateDir, dateFlag ? new Date(dateFlag) : new Date());
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { text: `No log file at ${path} yet.`, exitCode: 0 };
  }
  const linesFlag = parseFlag(args, "--lines");
  const allLines = raw.split("\n").filter((l) => l.trim());
  const tail = linesFlag ? allLines.slice(-Number(linesFlag)) : allLines;
  return { text: tail.join("\n"), exitCode: 0 };
}

/** `agent-relay daemon run-foreground` — what `daemon start` spawns and what the generated launchd plist's `ProgramArguments` literally invoke. Blocks until SIGTERM/SIGINT. */
async function daemonRunForegroundCommand(): Promise<never> {
  await runForeground();
  return new Promise<never>(() => {
    /* intentionally never resolves — this process exits via the SIGTERM/SIGINT handler installed inside runForeground(), not by returning here */
  });
}

/** Interactive-only (`--yes` is the non-interactive path): never guesses approval from a piped stdin, since this gates a real config-file write. */
async function confirmInteractively(promptText: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${promptText} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * Requirements #1/#2/#6: discovers installed agents, prints every
 * proposed change up front, and only calls `applySetup` after explicit
 * approval (`--yes` or an interactive yes) — nothing is written if the
 * plan is empty or isn't approved. Backups/preservation/idempotency are
 * all properties of the adapters themselves (see src/setup/
 * claudeCodeAdapter.ts), not this command.
 */
async function setupCommand(args: string[]): Promise<{ text: string; exitCode: number }> {
  const prereqs = await checkSetupPrerequisites(); // requirement #2 steps 1/3: OS/runtime + subscription auth, without reading credentials
  const summaries = await planSetup(defaultAdapters());
  const planText = [formatSetupPrerequisites(prereqs), "", formatSetupPlan(summaries)].join("\n");
  const hasChanges = summaries.some((s) => s.changes.length > 0);
  if (!hasChanges) return { text: [planText, "", "Nothing to set up."].join("\n"), exitCode: 0 };

  const approved = hasFlag(args, "--yes") || (await confirmInteractively("Apply the changes above?"));
  if (!approved) return { text: [planText, "", "Not applied (pass --yes, or approve interactively, to proceed)."].join("\n"), exitCode: 0 };

  const outcomes = await applySetup(defaultAdapters(), summaries);
  // Requirement #2 step 8: verify installation health right after applying, same aggregate check `doctor` exposes on demand.
  const health = await runDoctor();
  return { text: [planText, "", formatApplyOutcomes(outcomes), "", "Installation health:", health.text].join("\n"), exitCode: outcomes.some((o) => o.error) ? 1 : 0 };
}

async function integrationsStatusCommand(): Promise<{ text: string; exitCode: number }> {
  const statuses = await statusAll(defaultAdapters());
  return { text: formatStatusAll(statuses), exitCode: 0 };
}

async function integrationsRepairCommand(): Promise<{ text: string; exitCode: number }> {
  const outcomes = await repairAll(defaultAdapters());
  return { text: formatRepairOutcomes(outcomes), exitCode: outcomes.some((o) => o.error) ? 1 : 0 };
}

async function integrationsUninstallCommand(args: string[]): Promise<{ text: string; exitCode: number }> {
  const approved = hasFlag(args, "--yes") || (await confirmInteractively("Remove Agent Relay's own integration entries?"));
  if (!approved) return { text: "Not removed (pass --yes, or approve interactively, to proceed).", exitCode: 0 };
  const outcomes = await uninstallAll(defaultAdapters());
  return { text: formatUninstallOutcomes(outcomes), exitCode: outcomes.some((o) => o.error) ? 1 : 0 };
}

async function configShowCommand(): Promise<{ text: string; exitCode: number }> {
  const { config, error } = await loadConfig(defaultStoreRoot());
  const lines = error ? [`warning: ${error}`, ""] : [];
  lines.push(JSON.stringify(redact(config), null, 2));
  return { text: lines.join("\n"), exitCode: 0 };
}

async function configValidateCommand(): Promise<{ text: string; exitCode: number }> {
  const { config, error } = await loadConfig(defaultStoreRoot());
  if (error) return { text: `agent-relay: ${error}`, exitCode: 1 };
  const problems = validateConfig(config);
  if (problems.length === 0) return { text: "Config is valid.", exitCode: 0 };
  return { text: ["Config problems found:", ...problems.map((p) => `  - ${p}`)].join("\n"), exitCode: 1 };
}

/**
 * Requirement #6's aggregate health check, and requirement #2 step 8's
 * "verify installation health" — reused by both `agent-relay doctor` and
 * the end of `setup`. Never mutates anything; every sub-check it calls
 * (`checkSetupPrerequisites`, `statusAll`, `loadConfig`/`validateConfig`,
 * the daemon `ping`) already exists and is read-only.
 */
async function runDoctor(): Promise<{ text: string; exitCode: number }> {
  const prereqs = await checkSetupPrerequisites();
  const daemon = await daemonPingStatus();
  const statuses = await statusAll(defaultAdapters());
  const { config, error: configError } = await loadConfig(defaultStoreRoot());
  const configProblems = configError ? [configError] : validateConfig(config);

  const lines = [
    formatSetupPrerequisites(prereqs),
    "",
    daemon ? `daemon: running (pid ${daemon.pid}, up ${Math.round(daemon.uptimeMs / 1000)}s)` : "daemon: not running",
    "",
    formatStatusAll(statuses),
    "",
    configProblems.length === 0 ? "config: valid" : `config problems:\n${configProblems.map((p) => `  - ${p}`).join("\n")}`,
  ];

  const anyBroken = statuses.some((s) => s.entries.some((e) => e.status === "broken")) || configProblems.length > 0;
  return { text: lines.join("\n"), exitCode: anyBroken ? 1 : 0 };
}

function printHelp(): void {
  console.log(
    [
      "Usage: agent-relay <usage|sessions|inspect|handoff|auto|desktop> ...",
      "",
      "  usage codex                        Query Codex's account/rateLimits/read directly (no model prompt).",
      "  usage claude                        Report Claude usage observed from piped stream-json input, if any.",
      "  usage copilot                       Report Copilot usage observed from piped output, if any (unverified signal shape).",
      "  usage all                           Run all of the above.",
      "",
      "  sessions                            List discovered Codex + Claude sessions (read-only).",
      "  sessions --provider <claude|codex>  Filter by provider.",
      "  sessions --project <path>           Filter to sessions associated with that repo.",
      "  inspect <session-id>                Show full detail for one discovered session.",
      "  handoff prepare <session-id>        Build + persist a read-only handoff package for one session.",
      "  handoff execute <handoff-id> --to <claude|codex> [--objective \"...\"] [--force-lock] [--validate \"cmd\"]...",
      "                                       Run the cross-provider handoff (spawns a real coding-agent session).",
      "  handoff status <handoff-id>         Show a handoff's current state and attempt history.",
      "  tasks                                List all recorded tasks.",
      "  task inspect <task-id>              Show a task and all its handoffs.",
      "",
      "  auto start <task-id> [--objective \"...\"] [--validate \"cmd\"]... [--allow-unknown-availability] [--max-handoffs N] [--max-attempts N] [--max-runtime-ms N] [--pin <claude|codex>]",
      "                                       Start/resume automatic bidirectional handoff supervision (runs in the foreground until settled).",
      "  auto status <task-id>               Show the current automatic-handoff state.",
      "  auto pause <task-id>                Pause an in-progress automatic task.",
      "  auto resume <task-id> [--objective \"...\"]",
      "                                       Resume a paused automatic task, if the availability policy now permits it.",
      "  auto stop <task-id>                 Stop an automatic task permanently.",
      "  auto history <task-id>              Show every recorded state transition for an automatic task.",
      "",
      "  desktop register <session-id> --objective \"...\"",
      "                                       Register a desktop-originated session for task association.",
      "  desktop sessions                    List all registered desktop sessions.",
      "  desktop inspect <session-id>        Show one registered desktop session's ownership state and evidence.",
      "  desktop handoff <session-id> --to <claude|codex> [--force-lock] [--validate \"cmd\"]...",
      "                                       Assess ownership, then reuse `handoff execute`'s engine to continue the work.",
      "  desktop hook-event                  Read Claude Code hook JSON (one per line) from stdin and record it as evidence.",
      "",
      "  daemon install                      Generate the launchd plist (does not load/activate it — prints the command to run yourself).",
      "  daemon uninstall                    Remove the generated plist (does not unload it — prints the command to run yourself).",
      "  daemon start                        Spawn the daemon as a detached background process.",
      "  daemon stop                         Ask a running daemon to shut down gracefully.",
      "  daemon restart                      Stop, then start.",
      "  daemon status                       Report whether a daemon is running, and whether/if the plist is loaded by launchd.",
      "  daemon activate                      launchctl bootstrap the installed plist (idempotent).",
      "  daemon deactivate                    launchctl bootout the running launchd job (idempotent).",
      "  daemon logs [--date YYYY-MM-DD] [--lines N]",
      "                                       Show structured daemon log lines.",
      "",
      "  setup [--yes]                       Detect installed agents, show a plan of config changes, and apply it on approval.",
      "  integrations status                 Report installed/missing/broken/not-applicable integrations.",
      "  integrations repair                 Re-apply only what status reports missing/broken.",
      "  integrations uninstall [--yes]       Remove only Agent Relay's own integration entries (backs up first).",
      "  config show                         Print the resolved daemon configuration (defaults merged).",
      "  config validate                     Type/range-check the configuration; reports problems, never crashes.",
      "  doctor                              One aggregate health check: environment, auth, daemon, integrations, config.",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const [command, subcommand, ...rest] = process.argv.slice(2);
  if (command === "usage" && subcommand === "codex") {
    const { text, exitCode } = await codexStatus();
    console.log(text);
    return exitCode;
  }
  if (command === "usage" && subcommand === "claude") {
    const { text, exitCode } = await claudeStatus();
    console.log(text);
    return exitCode;
  }
  if (command === "usage" && subcommand === "copilot") {
    const { text, exitCode } = await copilotStatus();
    console.log(text);
    return exitCode;
  }
  if (command === "usage" && subcommand === "all") {
    const codex = await codexStatus();
    const claude = await claudeStatus();
    const copilot = await copilotStatus();
    console.log(codex.text);
    console.log("");
    console.log(claude.text);
    console.log("");
    console.log(copilot.text);
    return Math.max(codex.exitCode, claude.exitCode, copilot.exitCode);
  }
  if (command === "sessions") {
    const { text, exitCode } = await sessionsCommand(subcommand ? [subcommand, ...rest] : rest);
    console.log(text);
    return exitCode;
  }
  if (command === "inspect") {
    const { text, exitCode } = await inspectCommand(subcommand);
    console.log(text);
    return exitCode;
  }
  if (command === "handoff" && subcommand === "prepare") {
    const { text, exitCode } = await handoffPrepareCommand(rest);
    console.log(text);
    return exitCode;
  }
  if (command === "handoff" && subcommand === "execute") {
    const { text, exitCode } = await handoffExecuteCommand(rest);
    console.log(text);
    return exitCode;
  }
  if (command === "handoff" && subcommand === "status") {
    const { text, exitCode } = await handoffStatusCommand(rest[0]);
    console.log(text);
    return exitCode;
  }
  if (command === "tasks") {
    const { text, exitCode } = await tasksCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "task" && subcommand === "inspect") {
    const { text, exitCode } = await taskInspectCommand(rest[0]);
    console.log(text);
    return exitCode;
  }
  if (command === "auto" && subcommand === "start") {
    const { text, exitCode } = await autoStartCommand(rest);
    console.log(text);
    return exitCode;
  }
  if (command === "auto" && subcommand === "status") {
    const { text, exitCode } = await autoStatusCommand(rest[0]);
    console.log(text);
    return exitCode;
  }
  if (command === "auto" && subcommand === "pause") {
    const { text, exitCode } = await autoPauseCommand(rest[0]);
    console.log(text);
    return exitCode;
  }
  if (command === "auto" && subcommand === "resume") {
    const { text, exitCode } = await autoResumeCommand(rest);
    console.log(text);
    return exitCode;
  }
  if (command === "auto" && subcommand === "stop") {
    const { text, exitCode } = await autoStopCommand(rest[0]);
    console.log(text);
    return exitCode;
  }
  if (command === "auto" && subcommand === "history") {
    const { text, exitCode } = await autoHistoryCommand(rest[0]);
    console.log(text);
    return exitCode;
  }
  if (command === "desktop" && subcommand === "register") {
    const { text, exitCode } = await desktopRegisterCommand(rest);
    console.log(text);
    return exitCode;
  }
  if (command === "desktop" && subcommand === "sessions") {
    const { text, exitCode } = await desktopSessionsCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "desktop" && subcommand === "inspect") {
    const { text, exitCode } = await desktopInspectCommand(rest[0]);
    console.log(text);
    return exitCode;
  }
  if (command === "desktop" && subcommand === "handoff") {
    const { text, exitCode } = await desktopHandoffCommand(rest);
    console.log(text);
    return exitCode;
  }
  if (command === "desktop" && subcommand === "hook-event") {
    const { text, exitCode } = await desktopHookEventCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "daemon" && subcommand === "install") {
    const { text, exitCode } = await daemonInstallCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "daemon" && subcommand === "uninstall") {
    const { text, exitCode } = await daemonUninstallCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "daemon" && subcommand === "start") {
    const { text, exitCode } = await daemonStartCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "daemon" && subcommand === "stop") {
    const { text, exitCode } = await daemonStopCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "daemon" && subcommand === "restart") {
    const { text, exitCode } = await daemonRestartCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "daemon" && subcommand === "status") {
    const { text, exitCode } = await daemonStatusCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "daemon" && subcommand === "activate") {
    const { text, exitCode } = await daemonActivateCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "daemon" && subcommand === "deactivate") {
    const { text, exitCode } = await daemonDeactivateCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "daemon" && subcommand === "logs") {
    const { text, exitCode } = await daemonLogsCommand(rest);
    console.log(text);
    return exitCode;
  }
  if (command === "daemon" && subcommand === "run-foreground") {
    return daemonRunForegroundCommand();
  }
  if (command === "setup") {
    const { text, exitCode } = await setupCommand(subcommand ? [subcommand, ...rest] : rest);
    console.log(text);
    return exitCode;
  }
  if (command === "integrations" && subcommand === "status") {
    const { text, exitCode } = await integrationsStatusCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "integrations" && subcommand === "repair") {
    const { text, exitCode } = await integrationsRepairCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "integrations" && subcommand === "uninstall") {
    const { text, exitCode } = await integrationsUninstallCommand(rest);
    console.log(text);
    return exitCode;
  }
  if (command === "config" && subcommand === "show") {
    const { text, exitCode } = await configShowCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "config" && subcommand === "validate") {
    const { text, exitCode } = await configValidateCommand();
    console.log(text);
    return exitCode;
  }
  if (command === "doctor") {
    const { text, exitCode } = await runDoctor();
    console.log(text);
    return exitCode;
  }
  printHelp();
  return command === undefined ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`agent-relay: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
