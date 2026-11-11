import { spawn } from "node:child_process";
import type { UsageMonitor, UsageSnapshot } from "../usage/types.js";

/** Same cheap, zero-token presence check every other provider's monitor uses. */
export function defaultCheckCopilotCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("copilot", ["--version"], { stdio: "ignore" });
    proc.once("error", () => resolve(false));
    proc.once("exit", (code) => resolve(code === 0));
  });
}

const QUOTA_RE = /quota|usage limit|rate[ _]limit|ai credit|premium request/i;

/**
 * Best-effort classification of one parsed `--output-format json` line
 * from Copilot CLI. **Unverified**: this machine's real `copilot --help`/
 * `copilot help billing` output (see docs/MULTI_AGENT.md) confirms there
 * is no zero-turn usage endpoint and no documented structured rate-limit
 * event shape (unlike Claude's `rate_limit_event`) — `/usage` is an
 * interactive-only slash command. Deliberately does **not** scan the
 * entire raw line (field names could coincidentally match, the exact
 * mistake Phase 2C's own history records for Claude) — only a `message`/
 * `text`/`result` string field, if present. Until a real exhausted
 * sample is captured live, this will under-detect rather than guess.
 */
export function classifyCopilotLine(line: unknown): "exhausted" | "unknown" | null {
  if (typeof line !== "object" || line === null) return null;
  const obj = line as { message?: unknown; text?: unknown; result?: unknown };
  const text = [obj.message, obj.text, obj.result].find((v) => typeof v === "string") as string | undefined;
  if (!text) return null;
  return QUOTA_RE.test(text) ? "exhausted" : "unknown";
}

const DEFAULT_STALE_AFTER_MS = 20 * 60 * 1000;

/**
 * Passive, like `ClaudeUsageMonitor` (Phase 1B) and for the same reason:
 * no zero-turn usage endpoint exists for Copilot CLI (confirmed via this
 * machine's real `copilot help billing` output — `/usage` is interactive
 * only, `--usage-output-file` only reports after a real session ran).
 * Never spawns `copilot` to run a prompt — only classifies lines handed
 * to it from a session Agent Relay is already running for real work.
 */
export class CopilotUsageMonitor implements UsageMonitor {
  private last: { classification: "exhausted" | "unknown"; observedAt: number } | undefined;

  constructor(
    private readonly staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
    private readonly checkCliAvailable: () => Promise<boolean> = defaultCheckCopilotCliAvailable,
  ) {}

  observe(parsedLine: unknown): void {
    const result = classifyCopilotLine(parsedLine);
    if (!result) return;
    this.last = { classification: result, observedAt: Date.now() };
  }

  observeLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    try {
      this.observe(JSON.parse(trimmed));
    } catch {
      // not a JSON line — ignore rather than crash
    }
  }

  async getStatus(): Promise<UsageSnapshot> {
    const cliAvailable = await this.checkCliAvailable();
    if (!cliAvailable) {
      return { classification: "unknown", observedAt: null, primary: null, secondary: null, error: "copilot CLI was not found on PATH (checked via `copilot --version`)" };
    }
    if (!this.last) {
      return { classification: "unknown", observedAt: null, primary: null, secondary: null, error: "no usage signal has been observed yet — feed session output via observe()/observeLine() (and see docs/MULTI_AGENT.md: Copilot's exact usage-signal shape is unverified)" };
    }
    const ageMs = Date.now() - this.last.observedAt;
    if (ageMs > this.staleAfterMs) {
      return { classification: "unknown", observedAt: this.last.observedAt, primary: null, secondary: null, error: `last observation is stale (${Math.round(ageMs / 1000)}s old, exceeds ${Math.round(this.staleAfterMs / 1000)}s threshold)` };
    }
    return { classification: this.last.classification, observedAt: this.last.observedAt, primary: null, secondary: null };
  }

  async close(): Promise<void> {
    return;
  }
}
