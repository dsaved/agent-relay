import { join } from "node:path";
import { defaultStoreRoot } from "../handoff/store.js";
import { HandoffStore } from "../handoff/store.js";
import { WorkspaceLockManager } from "../handoff/lock.js";
import { AutomaticHandoffCoordinator, type StartAutoTaskOptions } from "../auto/coordinator.js";
import type { SessionProvider } from "../sessions/types.js";
import { CodexUsageMonitor } from "../codex/usageMonitor.js";
import { ClaudeUsageMonitor } from "../claude/usageMonitor.js";
import { DesktopRegistry } from "../desktop/registry.js";
import { loadConfig } from "./config.js";
import { DaemonLogger } from "./log.js";
import { TaskScheduler } from "./scheduler.js";
import { DesktopMonitor } from "./desktopMonitor.js";
import { runCrashRecovery } from "./recovery.js";
import { DaemonSocketServer, type CommandHandler } from "./socketServer.js";
import { pingDaemon, type PingResult } from "./client.js";

export function defaultSocketPath(stateDir: string): string {
  return join(stateDir, "daemon.sock");
}

export interface DaemonHandle {
  socketPath: string;
  stateDir: string;
  scheduler: TaskScheduler;
  registry: DesktopRegistry;
  logger: DaemonLogger;
  server: DaemonSocketServer;
  monitor: DesktopMonitor;
  stop: () => Promise<void>;
}

/**
 * The single-instance guard (requirement #1's "prevents multiple daemon
 * instances from controlling the same state directory"): the socket
 * itself is the source of truth — a real `ping` response means another
 * daemon already owns this state directory; anything else (no socket
 * file, a stale one nobody answers) means it's safe to proceed. No PID
 * file, so there's nothing to race against a PID the OS already reused.
 */
export async function assertNoExistingDaemon(socketPath: string): Promise<void> {
  const existing = await pingDaemon(socketPath, 1_000);
  if (existing) {
    throw new Error(`a daemon is already running for this state directory (pid ${existing.pid}, up ${Math.round(existing.uptimeMs / 1000)}s) — refusing to start a second one`);
  }
}

function buildHandlers(deps: {
  coordinator: AutomaticHandoffCoordinator;
  scheduler: TaskScheduler;
  store: HandoffStore;
  registry: DesktopRegistry;
  startedAt: number;
  stop: () => Promise<void>;
}): Record<string, CommandHandler> {
  const asTaskId = (args: unknown): string => {
    const taskId = (args as { taskId?: unknown } | undefined)?.taskId;
    if (typeof taskId !== "string" || !taskId) throw new Error("missing required `taskId`");
    return taskId;
  };

  return {
    ping: async (): Promise<PingResult> => ({ pid: process.pid, uptimeMs: Date.now() - deps.startedAt, version: "agent-relay-daemon" }),

    autoStart: async (args) => {
      const options = (args as { taskId: string; options?: StartAutoTaskOptions } | undefined)?.options ?? {};
      return deps.scheduler.submit(asTaskId(args), options);
    },
    autoResume: async (args) => {
      const a = args as { suppliedObjective?: string; pin?: SessionProvider } | undefined;
      return deps.scheduler.resume(asTaskId(args), a?.suppliedObjective, a?.pin);
    },
    autoPause: async (args) => deps.scheduler.requestPause(asTaskId(args)),
    autoStop: async (args) => deps.scheduler.requestStop(asTaskId(args)),
    autoStatus: async (args) => deps.store.loadAutoTask(asTaskId(args)),
    autoHistory: async (args) => (await deps.store.loadAutoTask(asTaskId(args)))?.transitions ?? [],
    autoListRunning: async () => deps.scheduler.listRunning(),

    providerAvailability: async () => {
      const codex = new CodexUsageMonitor();
      const claude = new ClaudeUsageMonitor();
      try {
        return { codex: await codex.getStatus(), claude: await claude.getStatus() };
      } finally {
        await codex.close();
        await claude.close();
      }
    },

    desktopSessions: async () => deps.registry.list(),
    desktopInspect: async (args) => deps.registry.get((args as { sessionId?: string } | undefined)?.sessionId ?? ""),

    // Responds first, then runs the graceful-shutdown sequence on the next
    // tick — a client waiting on this socket write must see the
    // acknowledgement before the socket itself goes away. Never calls
    // `process.exit()` itself: once `stop()` clears the poll timer and
    // closes the socket, a real daemon process has nothing left pending
    // and exits naturally — calling `process.exit()` from inside a
    // handler would be unsafe for an in-process caller (e.g. a test)
    // whose own host process must keep running regardless.
    shutdown: async () => {
      setImmediate(() => void deps.stop());
      return { acknowledged: true };
    },
  };
}

/**
 * Requirement #1's daemon entry point. Runs independently of any
 * terminal session — it is invoked either directly in the background by
 * `agent-relay daemon start` or as the literal `ProgramArguments` of the
 * generated launchd plist (`daemon run-foreground`), never by importing
 * the CLI. Does not require root: everything lives under the user's own
 * `~/.agent-relay` (or `$AGENT_RELAY_HOME`).
 */
export async function startDaemon(options: { stateDir?: string } = {}): Promise<DaemonHandle> {
  const stateDir = options.stateDir ?? defaultStoreRoot();
  const socketPath = defaultSocketPath(stateDir);
  const startedAt = Date.now();

  await assertNoExistingDaemon(socketPath);

  const { config, error: configError } = await loadConfig(stateDir);
  const logger = new DaemonLogger(stateDir);
  if (configError) await logger.write("daemon_startup", { warning: configError });
  await logger.rotate(config.logRetentionDays);

  const store = new HandoffStore(stateDir);
  const lockManager = new WorkspaceLockManager(store);
  const coordinator = new AutomaticHandoffCoordinator({ store, lockManager });
  const scheduler = new TaskScheduler(coordinator, store, config.maxConcurrentTasks, logger);
  const registry = new DesktopRegistry({ store, lockManager });
  const monitor = new DesktopMonitor(registry, config.desktopPollIntervalMs, logger);

  const recoveryDecisions = await runCrashRecovery(store, scheduler, lockManager, logger);
  await logger.write("daemon_startup", { pid: process.pid, stateDir, recoveredTasks: recoveryDecisions.length });

  // `buildHandlers` needs `stop`, and `stop` needs the not-yet-constructed
  // `server` — resolved with a small mutable indirection box instead of a
  // forward-referenced `let` (which `server` itself never needs to be).
  const stopBox: { run: () => Promise<void> } = { run: async () => undefined };
  const server = new DaemonSocketServer(socketPath, buildHandlers({ coordinator, scheduler, store, registry, startedAt, stop: () => stopBox.run() }));

  let stopped = false;
  stopBox.run = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    monitor.stop();
    await server.stop(); // stop accepting new connections/work first
    // Graceful (requirement #1): whatever is genuinely in flight right
    // now runs to its own settled outcome (bounded by the execution
    // adapter's own timeout — see src/execution/spawnRun.ts) rather than
    // being yanked mid-run.
    await scheduler.waitForIdle();
    await logger.write("daemon_shutdown", { pid: process.pid });
  };
  const stop = (): Promise<void> => stopBox.run();

  await server.start();
  monitor.start();

  return { socketPath, stateDir, scheduler, registry, logger, server, monitor, stop };
}

/** `agent-relay daemon run-foreground` — blocks until SIGTERM/SIGINT, exactly what a launchd job or a manually-spawned background process runs. */
export async function runForeground(options: { stateDir?: string } = {}): Promise<void> {
  const handle = await startDaemon(options);
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void handle.logger.write("daemon_shutdown", { signal }).then(() => handle.stop()).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
