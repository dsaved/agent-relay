import { spawn } from "node:child_process";
import type { SessionProvider } from "../sessions/types.js";

/**
 * Not an npm dependency — a separately-installed macOS CLI
 * (`brew install terminal-notifier`), detected the same honest way
 * `claude`/`codex`/`copilot` already are: absence is reported, never
 * fatal. macOS's built-in `osascript -e 'display notification'` cannot
 * show custom action buttons at all, which is why this is needed for a
 * real provider-choice prompt. Not installed on the machine this phase
 * was built on — the exact `-json` response shape below is
 * **UNVERIFIED** pending a live test once it's installed (see
 * docs/PROVIDER_CHOICE_NOTIFICATIONS.md).
 */
export function checkTerminalNotifierAvailable(spawnImpl: typeof spawn = spawn): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawnImpl("terminal-notifier", ["-help"], { stdio: "ignore" });
    proc.once("error", () => resolve(false));
    proc.once("exit", (code) => resolve(code === 0));
  });
}

interface TerminalNotifierResponse {
  activationType?: string;
  activationValue?: string;
}

function runNotifier(args: string[], spawnImpl: typeof spawn): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    const proc = spawnImpl("terminal-notifier", args, { stdio: ["ignore", "pipe", "ignore"] });
    proc.once("error", () => resolve(""));
    proc.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    proc.once("exit", () => resolve(stdout));
  });
}

/**
 * Shows an actionable notification offering `candidates` as buttons and
 * waits for the person to click one (blocking — this process invocation
 * doesn't return until they do, or the notification times out/is
 * dismissed). Returns the chosen provider, or `null` for "not installed,
 * dismissed, timed out, or an unparseable/unrecognized response" — this
 * never guesses a destination.
 */
export async function notifyProviderChoice(candidates: SessionProvider[], currentProvider: SessionProvider, taskId: string, spawnImpl: typeof spawn = spawn): Promise<SessionProvider | null> {
  if (candidates.length === 0) return null;
  const stdout = await runNotifier(
    ["-title", "Agent Relay", "-message", `${currentProvider} ran out for task ${taskId} — continue on:`, "-actions", candidates.join(","), "-json"],
    spawnImpl,
  );
  let parsed: TerminalNotifierResponse;
  try {
    parsed = JSON.parse(stdout.trim()) as TerminalNotifierResponse;
  } catch {
    return null;
  }
  if (parsed.activationType !== "actionClicked" || !parsed.activationValue) return null;
  const match = candidates.find((c) => c.toLowerCase() === parsed.activationValue!.toLowerCase());
  return match ?? null;
}

/** Plain, non-actionable: a seeded session is ready to view, and `handoff open` is the next manual step. */
export async function notifyReadyToOpen(handoffId: string, provider: SessionProvider, spawnImpl: typeof spawn = spawn): Promise<void> {
  await runNotifier(["-title", "Agent Relay", "-message", `Ready — run: agent-relay handoff open ${handoffId} --to ${provider}`], spawnImpl);
}
