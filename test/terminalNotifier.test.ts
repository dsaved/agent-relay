import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { checkTerminalNotifierAvailable, notifyProviderChoice, notifyReadyToOpen } from "../src/notify/terminalNotifier.js";

function fakeStdout(): EventEmitter & { setEncoding: (enc: string) => EventEmitter } {
  const stream = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => EventEmitter };
  stream.setEncoding = () => stream;
  return stream;
}

function fakeSpawn(exitCode: number, stdout: string) {
  const calls: { command: string; args: string[] }[] = [];
  const fn = (command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
    child.stdout = fakeStdout();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", stdout);
      child.emit("exit", exitCode);
    });
    return child as never;
  };
  return { fn, calls };
}

function fakeSpawnMissing() {
  const fn = (_command: string, _args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
    child.stdout = fakeStdout();
    queueMicrotask(() => child.emit("error", new Error("spawn terminal-notifier ENOENT")));
    return child as never;
  };
  return { fn };
}

test("checkTerminalNotifierAvailable: not installed -> false, never throws", async () => {
  const missing = fakeSpawnMissing();
  assert.equal(await checkTerminalNotifierAvailable(missing.fn as never), false);
});

test("checkTerminalNotifierAvailable: exit 0 -> true", async () => {
  const present = fakeSpawn(0, "");
  assert.equal(await checkTerminalNotifierAvailable(present.fn as never), true);
});

test("notifyProviderChoice: builds -actions from the candidate list and -json for a parseable response", async () => {
  const spawn = fakeSpawn(0, JSON.stringify({ activationType: "actionClicked", activationValue: "claude" }));
  const picked = await notifyProviderChoice(["codex", "claude"], "claude", "task-1", spawn.fn as never);
  assert.deepEqual(spawn.calls[0]!.args, ["-title", "Agent Relay", "-message", "claude ran out for task task-1 — continue on:", "-actions", "codex,claude", "-json"]);
  assert.equal(picked, "claude");
});

test("notifyProviderChoice: a dismissed/timed-out notification (no actionClicked) -> null, never guessed", async () => {
  const spawn = fakeSpawn(0, JSON.stringify({ activationType: "timeout" }));
  const picked = await notifyProviderChoice(["codex"], "claude", "task-1", spawn.fn as never);
  assert.equal(picked, null);
});

test("notifyProviderChoice: unparseable stdout (terminal-notifier not installed, or an unexpected format) -> null, never throws", async () => {
  const spawn = fakeSpawn(0, "not json at all");
  const picked = await notifyProviderChoice(["codex"], "claude", "task-1", spawn.fn as never);
  assert.equal(picked, null);
});

test("notifyProviderChoice: an activationValue not among the offered candidates -> null, never a wrong guess", async () => {
  const spawn = fakeSpawn(0, JSON.stringify({ activationType: "actionClicked", activationValue: "copilot" }));
  const picked = await notifyProviderChoice(["codex", "claude"], "claude", "task-1", spawn.fn as never);
  assert.equal(picked, null);
});

test("notifyProviderChoice: an empty candidate list never spawns anything", async () => {
  const spawn = fakeSpawn(0, "");
  await notifyProviderChoice([], "claude", "task-1", spawn.fn as never);
  assert.equal(spawn.calls.length, 0);
});

test("notifyReadyToOpen: builds the plain, non-actionable message with the exact handoff open command", async () => {
  const spawn = fakeSpawn(0, "");
  await notifyReadyToOpen("handoff-123", "claude", spawn.fn as never);
  assert.deepEqual(spawn.calls[0]!.args, ["-title", "Agent Relay", "-message", "Ready — run: agent-relay handoff open handoff-123 --to claude"]);
});
