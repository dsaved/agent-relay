import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

/**
 * A fake `claude` executable for the real, installed-binary integration
 * test (`test/integrationLifecycle.test.ts`) — this project's own
 * restriction against live model calls means the real `codex`/`claude`
 * CLIs can never be exercised end-to-end here, so this stands in for
 * `claude` on `PATH` the same way `FakeExecutionAdapter` stands in at the
 * library level everywhere else in this test suite, just reachable by a
 * real spawned daemon subprocess instead of an injected TS object.
 *
 * Behavior is driven entirely by two files the test itself controls, not
 * by anything the real `ClaudeExecutionAdapter` passes on the command
 * line (whose exact instruction text varies across retried legs):
 * - `sleepGatePath` present -> blocks (simulates an in-flight run, so the
 *   test has a real window to pause it).
 * - `sleepGatePath` absent -> emits a successful `stream-json` `result`
 *   event and exits 0.
 * Every invocation appends its own pid to `pidsLogPath` so the test can
 * clean up any orphaned (paused-and-then-crashed-out-from-under)
 * processes afterward — requirement: "verify all temporary processes...
 * are cleaned up."
 */
export interface FakeCliBin {
  binDir: string;
  sleepGatePath: string;
  pidsLogPath: string;
}

const SCRIPT = `#!/usr/bin/env node
const fs = require("fs");
const pidsLog = process.env.FAKE_CLAUDE_PIDS_LOG;
if (pidsLog) { try { fs.appendFileSync(pidsLog, process.pid + "\\n"); } catch {} }

const args = process.argv.slice(2);

// Everything this test's own setup/doctor/discovery machinery calls
// besides the real execution-adapter invocation must answer quickly and
// never block — only "-p ... <instruction>" (ClaudeExecutionAdapter's own
// shape, src/execution/claudeExecutionAdapter.ts) is the one invocation
// this script lets block on the sleep gate below.
if (args[0] === "--version") { console.log("fake-claude 0.0.0-test"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") { console.log(JSON.stringify({ authMethod: "claude.ai", subscriptionType: "pro" })); process.exit(0); }
if (args[0] === "agents") { console.log("[]"); process.exit(0); }
if (args[0] !== "-p") { process.exit(0); }

const sleepGate = process.env.FAKE_CLAUDE_SLEEP_GATE;
console.log(JSON.stringify({ type: "system", subtype: "init" }));
if (sleepGate && fs.existsSync(sleepGate)) {
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ type: "result", is_error: false, result: "fake completion", session_id: "fake-claude-session" }));
  process.exit(0);
}
`;

/**
 * A fake `codex` too — not to simulate real Codex behavior, but to
 * *shadow* a real `codex` binary this machine may actually have
 * installed (this project's own earlier phases confirm one often is).
 * Without this, `PATH`-prepending only `claude` would leave the real
 * `codex` reachable, and the coordinator's own automatic provider-
 * bounce logic (src/auto/providerSelection.ts) would then spawn it for
 * real — exactly the live call this phase's restrictions forbid. Its
 * `app-server --stdio` handshake is the minimal, documented JSON-RPC
 * this project's own `ProcessCodexAppServerTransport` speaks
 * (src/codex/appServerTransport.ts) — answered with an empty/unknown
 * rate-limit result, never a guess at the real account's status; its
 * `exec` mode is a deliberate, controlled failure (never a real
 * execution) so the coordinator bounces away from it exactly like a
 * genuine crash would.
 */
const CODEX_SCRIPT = `#!/usr/bin/env node
const readline = require("readline");
const args = process.argv.slice(2);

if (args[0] === "--version") { console.log("fake-codex 0.0.0-test"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { console.log("Logged in using ChatGPT"); process.exit(0); }

if (args[0] === "app-server") {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined) return; // a notification (e.g. "initialized") - no response
    const result = msg.method === "account/rateLimits/read" ? { rateLimits: {} } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  });
  return;
}

if (args[0] === "exec") {
  console.error("fake-codex: simulated failure (integration test stand-in - no real execution, no model call)");
  process.exit(1);
}

process.exit(0);
`;

export async function createFakeCliBin(dir: string): Promise<FakeCliBin> {
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const claudePath = join(binDir, "claude");
  await writeFile(claudePath, SCRIPT);
  await chmod(claudePath, 0o755);
  const codexPath = join(binDir, "codex");
  await writeFile(codexPath, CODEX_SCRIPT);
  await chmod(codexPath, 0o755);
  return { binDir, sleepGatePath: join(dir, "sleep.gate"), pidsLogPath: join(dir, "pids.log") };
}
