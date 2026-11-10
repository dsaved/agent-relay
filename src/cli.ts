#!/usr/bin/env node
import { createInterface } from "node:readline";
import { CodexUsageMonitor } from "./codex/usageMonitor.js";
import { formatCodexUsageStatus } from "./codex/formatUsage.js";
import { ClaudeUsageMonitor } from "./claude/usageMonitor.js";
import { formatClaudeUsageStatus } from "./claude/formatUsage.js";
import type { UsageSnapshot } from "./usage/types.js";
import { discoverAllSessions } from "./sessions/discoverAll.js";
import { detectWorktreeInfo } from "./sessions/projectAssociation.js";
import { prepareHandoffSnapshot } from "./sessions/handoff.js";
import { formatSessionLine, formatHandoffSnapshot } from "./sessions/format.js";
import type { SessionProvider } from "./sessions/types.js";
import { HandoffStore } from "./handoff/store.js";
import { createHandoffRecord } from "./handoff/prepare.js";
import { HandoffEngine } from "./handoff/engine.js";
import { formatHandoffRecord, formatTask } from "./handoff/format.js";
import { AutomaticHandoffCoordinator } from "./auto/coordinator.js";
import { formatAutoTaskState, formatAutoHistory } from "./auto/format.js";
import { DesktopRegistry, parseHookEvent } from "./desktop/registry.js";
import { requestDesktopHandoff } from "./desktop/handoff.js";
import { formatDesktopSession } from "./desktop/format.js";

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
  if (providerFlag && providerFlag !== "claude" && providerFlag !== "codex") {
    return { text: `Unknown --provider "${providerFlag}" (expected "claude" or "codex")`, exitCode: 1 };
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
 * Runs in the foreground for Phase 3A (requirement #7) — it drives the
 * coordinator's loop to completion/pause/failure and exits; persistent
 * background operation is a later daemon phase, not this one.
 */
async function autoStartCommand(args: string[]): Promise<{ text: string; exitCode: number }> {
  const taskId = args[0];
  if (!taskId) return { text: "Usage: agent-relay auto start <task-id> [--objective \"...\"] [--validate \"cmd\"]... [--allow-unknown-availability] [--max-handoffs N] [--max-attempts N] [--max-runtime-ms N] [--pin <claude|codex>]", exitCode: 1 };

  const coordinator = new AutomaticHandoffCoordinator();
  try {
    const pin = parseFlag(args, "--pin");
    if (pin && pin !== "claude" && pin !== "codex") return { text: `Unknown --pin "${pin}" (expected "claude" or "codex")`, exitCode: 1 };

    const state = await coordinator.start(taskId, {
      suppliedObjective: parseFlag(args, "--objective"),
      validationCommands: parseAllFlags(args, "--validate"),
      allowUnknownAvailability: hasFlag(args, "--allow-unknown-availability"),
      maxHandoffs: parseFlag(args, "--max-handoffs") ? Number(parseFlag(args, "--max-handoffs")) : undefined,
      maxAttempts: parseFlag(args, "--max-attempts") ? Number(parseFlag(args, "--max-attempts")) : undefined,
      maxRuntimeMs: parseFlag(args, "--max-runtime-ms") ? Number(parseFlag(args, "--max-runtime-ms")) : undefined,
      pinnedProvider: pin as "claude" | "codex" | undefined,
    });
    return { text: formatAutoTaskState(state), exitCode: exitCodeForAutoState(state.state) };
  } catch (err) {
    return { text: `agent-relay: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
  }
}

async function autoStatusCommand(taskId: string | undefined): Promise<{ text: string; exitCode: number }> {
  if (!taskId) return { text: "Usage: agent-relay auto status <task-id>", exitCode: 1 };
  const state = await new AutomaticHandoffCoordinator().status(taskId);
  if (!state) return { text: `No automatic task state found for "${taskId}".`, exitCode: 1 };
  return { text: formatAutoTaskState(state), exitCode: 0 };
}

async function autoPauseCommand(taskId: string | undefined): Promise<{ text: string; exitCode: number }> {
  if (!taskId) return { text: "Usage: agent-relay auto pause <task-id>", exitCode: 1 };
  try {
    const state = await new AutomaticHandoffCoordinator().pause(taskId);
    return { text: formatAutoTaskState(state), exitCode: 0 };
  } catch (err) {
    return { text: `agent-relay: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
  }
}

async function autoResumeCommand(args: string[]): Promise<{ text: string; exitCode: number }> {
  const taskId = args[0];
  if (!taskId) return { text: "Usage: agent-relay auto resume <task-id> [--objective \"...\"]", exitCode: 1 };
  try {
    const state = await new AutomaticHandoffCoordinator().resume(taskId, { suppliedObjective: parseFlag(args, "--objective") });
    return { text: formatAutoTaskState(state), exitCode: exitCodeForAutoState(state.state) };
  } catch (err) {
    return { text: `agent-relay: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
  }
}

async function autoStopCommand(taskId: string | undefined): Promise<{ text: string; exitCode: number }> {
  if (!taskId) return { text: "Usage: agent-relay auto stop <task-id>", exitCode: 1 };
  try {
    const state = await new AutomaticHandoffCoordinator().stop(taskId);
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

function printHelp(): void {
  console.log(
    [
      "Usage: agent-relay <usage|sessions|inspect|handoff|auto|desktop> ...",
      "",
      "  usage codex                        Query Codex's account/rateLimits/read directly (no model prompt).",
      "  usage claude                        Report Claude usage observed from piped stream-json input, if any.",
      "  usage all                           Run both of the above.",
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
  if (command === "usage" && subcommand === "all") {
    const codex = await codexStatus();
    const claude = await claudeStatus();
    console.log(codex.text);
    console.log("");
    console.log(claude.text);
    return Math.max(codex.exitCode, claude.exitCode);
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
  printHelp();
  return command === undefined ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`agent-relay: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
