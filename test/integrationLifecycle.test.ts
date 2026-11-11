import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAlive } from "../src/handoff/lock.js";
import { pingDaemon } from "../src/daemon/client.js";
import { defaultSocketPath } from "../src/daemon/process.js";
import { HandoffStore } from "../src/handoff/store.js";
import { createHandoffRecord } from "../src/handoff/prepare.js";
import { logPath } from "../src/daemon/log.js";
import { createFakeCliBin } from "./helpers/fakeCliBin.js";
import { git } from "./helpers/tempGitRepo.js";
import { makeSessionAssociation } from "./helpers/tempHandoffEnv.js";

/**
 * A disposable git repo that lives for this whole test (unlike
 * `withTempRepo`, which removes it the moment its callback returns) —
 * the real daemon subprocess needs the workspace to still exist while a
 * task is mid-flight, long after it was created.
 */
async function makeLongLivedRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  git(["init", "-q"], path);
  git(["config", "user.email", "test@test.local"], path);
  git(["config", "user.name", "test"], path);
  await writeFile(join(path, "README.md"), "hello\n");
  git(["add", "."], path);
  git(["commit", "-q", "-m", "init"], path);
  return path;
}

const execFileAsync = promisify(execFile);

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCli(binPath: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [binPath, ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    proc.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    proc.once("exit", (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function parseState(statusText: string): string | null {
  return /state:\s*(\S+)/.exec(statusText)?.[1] ?? null;
}

/** `pidsLogPath` gets one line per fake-claude invocation of *any* kind (`--version`, `agents --json`, the real execution-adapter call, ...) — this counts lines rather than mere existence, so callers can wait for a *new* invocation past some earlier baseline instead of being fooled by the file already existing from setup's own detection calls. */
async function countPidLines(path: string): Promise<number> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function killTrackedPids(pidsLogPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(pidsLogPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Requirement (Phase 6 continuation) #2: the complete install->setup->
 * daemon->task->pause->resume->crash-recovery->uninstall lifecycle,
 * driven entirely through the real globally-installed binary from a
 * real `npm pack` tarball — everything confined to disposable
 * directories (`mkdtemp`), never this machine's real `$HOME` or global
 * npm state. No real `codex`/`claude` model call is ever made: `claude`
 * is replaced on `PATH` by a scripted stand-in (`test/helpers/
 * fakeCliBin.ts`) — the same role `FakeExecutionAdapter` plays at the
 * library level everywhere else in this suite, just reachable by a real
 * spawned process instead of an injected object. `codex` is left absent
 * from `PATH` entirely: this task's own provider-selection logic (`src/
 * auto/providerSelection.ts`) already treats a provider with "unknown"
 * availability as select-with-caution only under `--allow-unknown-
 * availability`, bounded, so codex's absence is exercised as a genuine
 * "crashed" outcome the coordinator bounces away from automatically —
 * not faked, the real behavior for a genuinely unreachable CLI.
 */
test(
  "full install -> setup -> daemon -> task -> pause/resume -> crash recovery -> uninstall lifecycle",
  { timeout: 120_000 },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "agent-relay-integration-"));
    const packDir = join(scratch, "pack");
    const prefixDir = join(scratch, "prefix");
    const fakeHome = join(scratch, "home");
    const stateDir = join(scratch, "state");
    const outsideCwd = join(scratch, "cwd");
    await mkdir(packDir, { recursive: true });
    await mkdir(prefixDir, { recursive: true });
    await mkdir(fakeHome, { recursive: true });
    await mkdir(outsideCwd, { recursive: true });

    let daemonStarted = false;
    let fakeCli: Awaited<ReturnType<typeof createFakeCliBin>> | null = null;

    try {
      fakeCli = await createFakeCliBin(scratch);
      const cli = fakeCli; // a plain `const` so TS narrows it inside closures below, unlike the outer `let`
      // --- 1. Pack and install into an isolated global prefix ---
      const packResult = await execFileAsync("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: process.cwd() });
      const packInfo = JSON.parse(packResult.stdout) as { filename: string }[];
      const tarballPath = join(packDir, packInfo[0]!.filename);
      assert.ok(await fileExists(tarballPath), "npm pack must actually produce the tarball file it reports");

      await execFileAsync("npm", ["install", "-g", tarballPath, "--prefix", prefixDir], { cwd: scratch });
      const binPath = join(prefixDir, "bin", "agent-relay");
      assert.ok(await fileExists(binPath), "the global bin must exist under the isolated prefix");

      // No recognized command -> prints help and exits 0 (only an unrecognized *named* command exits 1); this is just a smoke check that the installed binary runs at all from a cwd outside the source repo.
      const helpResult = await runCli(binPath, [], process.env, outsideCwd);
      assert.equal(helpResult.exitCode, 0, "the installed binary must run correctly from a cwd outside the source repo");
      assert.match(helpResult.stdout, /Usage: agent-relay/);

      const env = { ...process.env, HOME: fakeHome, AGENT_RELAY_HOME: stateDir, PATH: `${cli.binDir}:${process.env.PATH}`, FAKE_CLAUDE_SLEEP_GATE: cli.sleepGatePath, FAKE_CLAUDE_PIDS_LOG: cli.pidsLogPath };

      // --- 2/3/4. setup --yes, then verify hooks + preservation ---
      const claudeSettingsPath = join(fakeHome, ".claude", "settings.json");
      await mkdir(join(fakeHome, ".claude"), { recursive: true });
      const unrelatedSettings = { model: "unrelated-model", hooks: { Notification: [{ hooks: [{ type: "command", command: "echo unrelated-notification" }] }] } };
      await writeFile(claudeSettingsPath, JSON.stringify(unrelatedSettings, null, 2));

      const setupResult = await runCli(binPath, ["setup", "--yes"], env, outsideCwd);
      assert.equal(setupResult.exitCode, 0, `setup --yes must succeed: ${setupResult.stdout}\n${setupResult.stderr}`);

      const settingsAfterSetup = JSON.parse(await readFile(claudeSettingsPath, "utf8"));
      assert.equal(settingsAfterSetup.model, "unrelated-model", "an unrelated setting must survive setup untouched");
      assert.equal(settingsAfterSetup.hooks.Notification[0].hooks[0].command, "echo unrelated-notification", "an unrelated hook must survive setup untouched");
      assert.equal(settingsAfterSetup.hooks.Stop.length, 1, "setup must install exactly one Stop hook");
      assert.equal(settingsAfterSetup.hooks.SessionEnd.length, 1, "setup must install exactly one SessionEnd hook");
      assert.match(settingsAfterSetup.hooks.Stop[0].hooks[0].command, /desktop hook-event/);

      // --- 5. Start the background daemon ---
      const startResult = await runCli(binPath, ["daemon", "start"], env, outsideCwd);
      assert.equal(startResult.exitCode, 0, `daemon start must succeed: ${startResult.stdout}`);
      daemonStarted = true;
      const socketPath = defaultSocketPath(stateDir);
      assert.ok(await pingDaemon(socketPath), "the started daemon must be reachable");

      // --- 6/7/8/9. Submit task A, exit the submitting CLI (it already did — runCli spawned and exited), pause, resume ---
      const store = new HandoffStore(stateDir);
      const repoARoot = await makeLongLivedRepo(join(scratch, "repo-a"));
      const sessionA = makeSessionAssociation({ provider: "codex", sessionId: "fake-codex-source-a", repoRoot: repoARoot, workspaceAccessible: true, title: "Integration test task A" });
      const { task: taskARecord, handoff: handoffA } = await createHandoffRecord(sessionA);
      await store.saveTask(taskARecord);
      await store.saveHandoff(handoffA);
      const taskA = { taskId: taskARecord.taskId, repoRoot: repoARoot };

      const pidCountBeforeA = await countPidLines(cli.pidsLogPath);
      await writeFile(cli.sleepGatePath, "sleep");
      const submitResult = await runCli(binPath, ["auto", "start", taskA.taskId, "--allow-unknown-availability"], env, outsideCwd);
      assert.equal(submitResult.exitCode, 0, `auto start must be accepted: ${submitResult.stdout}\n${submitResult.stderr}`);
      assert.match(submitResult.stdout, /Accepted by the daemon/);

      assert.ok(await waitFor(async () => (await countPidLines(cli.pidsLogPath)) > pidCountBeforeA, 15_000), "the fake claude process must have been invoked for task A's real execution leg, not just setup's own detection calls");

      const pauseResult = await runCli(binPath, ["auto", "pause", taskA.taskId], env, outsideCwd);
      assert.equal(parseState(pauseResult.stdout), "paused_approval", `pausing an in-flight run must reach paused_approval: ${pauseResult.stdout}`);

      await rm(cli.sleepGatePath, { force: true });
      const resumeResult = await runCli(binPath, ["auto", "resume", taskA.taskId], env, outsideCwd);
      assert.equal(resumeResult.exitCode, 0, `auto resume must be accepted: ${resumeResult.stdout}`);

      let lastStatusText = "";
      const reachedCompleted = await waitFor(async () => {
        const status = await runCli(binPath, ["auto", "status", taskA.taskId], env, outsideCwd);
        lastStatusText = status.stdout;
        return parseState(status.stdout) === "completed";
      }, 20_000);
      assert.ok(reachedCompleted, `task A must reach 'completed' after resume, without the submitting CLI having stayed alive the whole time. Last status:\n${lastStatusText}`);

      // --- 10/11. Task B: crash recovery, no duplicate workers ---
      const repoBRoot = await makeLongLivedRepo(join(scratch, "repo-b"));
      const sessionB = makeSessionAssociation({ provider: "codex", sessionId: "fake-codex-source-b", repoRoot: repoBRoot, workspaceAccessible: true, title: "Integration test task B" });
      const { task: taskBRecord, handoff: handoffB } = await createHandoffRecord(sessionB);
      await store.saveTask(taskBRecord);
      await store.saveHandoff(handoffB);
      const taskB = { taskId: taskBRecord.taskId, repoRoot: repoBRoot };

      await writeFile(cli.sleepGatePath, "sleep");
      const submitB = await runCli(binPath, ["auto", "start", taskB.taskId, "--allow-unknown-availability"], env, outsideCwd);
      assert.equal(submitB.exitCode, 0);

      const pingBeforeCrash = await pingDaemon(socketPath);
      assert.ok(pingBeforeCrash, "the daemon must be up before the simulated crash");
      assert.ok(
        await waitFor(async () => {
          const status = await runCli(binPath, ["auto", "status", taskB.taskId], env, outsideCwd);
          return parseState(status.stdout) === "handing_off" || parseState(status.stdout) === "validating" || parseState(status.stdout) === "running";
        }, 15_000),
        "task B must actually be mid-flight before the crash",
      );

      process.kill(pingBeforeCrash!.pid, "SIGKILL"); // simulate an unexpected daemon crash, never a graceful stop
      assert.ok(await waitFor(async () => (await pingDaemon(socketPath, 300)) === null, 5_000), "the killed daemon must stop answering");

      // Removed *before* restarting, not after: crash recovery kicks off
      // its background retry as soon as the new daemon process starts up
      // (before its socket is even listening, let alone before this call
      // returns) — removing the gate only after confirming the restart
      // would race the recovered attempt, which can reach the fake
      // claude invocation first and see the gate still present.
      await rm(cli.sleepGatePath, { force: true });
      const restartResult = await runCli(binPath, ["daemon", "start"], env, outsideCwd);
      assert.equal(restartResult.exitCode, 0, `restarting after a crash must succeed: ${restartResult.stdout}`);

      let lastStatusTextB = "";
      const taskBCompleted = await waitFor(async () => {
        const status = await runCli(binPath, ["auto", "status", taskB.taskId], env, outsideCwd);
        lastStatusTextB = status.stdout;
        return parseState(status.stdout) === "completed";
      }, 20_000);
      if (!taskBCompleted) {
        const history = await runCli(binPath, ["auto", "history", taskB.taskId], env, outsideCwd);
        const pids = await readFile(cli.pidsLogPath, "utf8").catch(() => "(no pids log)");
        const daemonLog = await readFile(logPath(stateDir), "utf8").catch((e) => `(no daemon log: ${e.message})`);
        assert.ok(false, `task B must recover safely and reach 'completed' after the daemon restart.\nLast status:\n${lastStatusTextB}\nHistory:\n${history.stdout}\nPids log:\n${pids}\nDaemon log:\n${daemonLog}`);
      }

      const taskBAfter = await store.loadAutoTask(taskB.taskId);
      assert.equal(taskBAfter?.handoffCount, 1, "recovery must continue the same leg, never spin up a second, duplicate handoff for the same crash-interrupted attempt");

      // --- 12. integrations status / doctor ---
      const statusCmd = await runCli(binPath, ["integrations", "status"], env, outsideCwd);
      assert.equal(statusCmd.exitCode, 0);
      assert.match(statusCmd.stdout, /claude-code/);
      assert.match(statusCmd.stdout, /codex/);

      const doctorCmd = await runCli(binPath, ["doctor"], env, outsideCwd);
      assert.match(doctorCmd.stdout, /environment:/);

      // --- 13/14. Uninstall, verify only our own entries were removed ---
      const uninstallResult = await runCli(binPath, ["integrations", "uninstall", "--yes"], env, outsideCwd);
      assert.equal(uninstallResult.exitCode, 0, `uninstall must succeed: ${uninstallResult.stdout}`);

      const settingsAfterUninstall = JSON.parse(await readFile(claudeSettingsPath, "utf8"));
      assert.equal(settingsAfterUninstall.model, "unrelated-model", "the unrelated setting must still be there after uninstall");
      assert.equal(settingsAfterUninstall.hooks.Notification[0].hooks[0].command, "echo unrelated-notification", "the unrelated hook must still be there after uninstall");
      assert.equal(settingsAfterUninstall.hooks.Stop?.length ?? 0, 0, "our Stop hook must be gone after uninstall");
      assert.equal(settingsAfterUninstall.hooks.SessionEnd?.length ?? 0, 0, "our SessionEnd hook must be gone after uninstall");

      const stopResult = await runCli(binPath, ["daemon", "stop"], env, outsideCwd);
      assert.equal(stopResult.exitCode, 0);
      daemonStarted = false;
      assert.ok(await waitFor(async () => (await pingDaemon(socketPath, 300)) === null, 5_000));
    } finally {
      // --- 15. Clean up every temporary process and file ---
      if (daemonStarted) {
        const ping = await pingDaemon(defaultSocketPath(stateDir), 500);
        if (ping) process.kill(ping.pid, "SIGKILL");
      }
      if (fakeCli) await killTrackedPids(fakeCli.pidsLogPath);
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
