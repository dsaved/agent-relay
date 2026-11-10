import { spawn } from "node:child_process";
import { classifyClaudeLine } from "../classifyRateLimit.js";
import type { UsageMonitor, UsageSnapshot, UsageWindow } from "../usage/types.js";

const DEFAULT_STALE_AFTER_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Checks that the Claude CLI is actually on PATH, the same cheap,
 * zero-token way Phase 0 confirmed it (`claude --version`). This is the
 * "unavailable CLI" signal for a monitor that otherwise never spawns the
 * CLI itself — see the class doc comment below for why.
 */
export function defaultCheckClaudeCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["--version"], { stdio: "ignore" });
    proc.once("error", () => resolve(false));
    proc.once("exit", (code) => resolve(code === 0));
  });
}

/**
 * Claude Code has no documented, zero-turn endpoint analogous to Codex's
 * `account/rateLimits/read` (see docs/FEASIBILITY.md Phase 1B for the
 * investigation). The only documented source of rate-limit data is the
 * `rate_limit_event` line Claude emits on `--output-format stream-json`
 * output of a *real* turn — so this monitor is passive: it never spawns
 * `claude` to run a prompt, it only classifies lines handed to it from a
 * session Agent Relay is already running for real work (`observe`/
 * `observeLine`), and reports "unknown" (not a guess) when it has nothing
 * fresh to go on.
 */
export class ClaudeUsageMonitor implements UsageMonitor {
  private last: { classification: "available" | "exhausted" | "unknown"; observedAt: number; primary: UsageWindow | null; secondary: UsageWindow | null } | undefined;

  constructor(
    private readonly staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
    private readonly checkCliAvailable: () => Promise<boolean> = defaultCheckClaudeCliAvailable,
  ) {}

  /** Feeds one already-JSON-parsed line from a Claude stream-json session. Non-`rate_limit_event` lines (including malformed/irrelevant ones) are silently ignored, never thrown. */
  observe(parsedLine: unknown): void {
    const result = classifyClaudeLine(parsedLine);
    if (!result) return; // not a rate_limit_event line — nothing to learn from it

    this.last = {
      classification: result.classification === "ok" ? "available" : result.classification,
      observedAt: Date.now(),
      primary: result.primary ?? null,
      secondary: result.secondary ?? null,
    };
  }

  /** Feeds one raw NDJSON line (e.g. piped from `claude -p --output-format stream-json`). Invalid JSON is ignored, never thrown. */
  observeLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    try {
      this.observe(JSON.parse(trimmed));
    } catch {
      // not a JSON line — ignore rather than crash, same as the transport's line parser
    }
  }

  async getStatus(): Promise<UsageSnapshot> {
    const cliAvailable = await this.checkCliAvailable();
    if (!cliAvailable) {
      return {
        classification: "unknown",
        observedAt: null,
        primary: null,
        secondary: null,
        error: "claude CLI was not found on PATH (checked via `claude --version`)",
      };
    }

    if (!this.last) {
      return {
        classification: "unknown",
        observedAt: null,
        primary: null,
        secondary: null,
        error: "no rate_limit_event has been observed yet — feed session output via observe()/observeLine()",
      };
    }

    const ageMs = Date.now() - this.last.observedAt;
    if (ageMs > this.staleAfterMs) {
      return {
        classification: "unknown",
        observedAt: this.last.observedAt,
        primary: this.last.primary,
        secondary: this.last.secondary,
        error: `last observation is stale (${Math.round(ageMs / 1000)}s old, exceeds ${Math.round(this.staleAfterMs / 1000)}s threshold) — not assuming it still holds`,
      };
    }

    return {
      classification: this.last.classification,
      observedAt: this.last.observedAt,
      primary: this.last.primary,
      secondary: this.last.secondary,
      ...(this.last.classification === "unknown"
        ? { error: "the most recent rate_limit_event had an unrecognized or missing `status` field" }
        : {}),
    };
  }

  // Passive monitor — nothing to tear down.
  async close(): Promise<void> {
    return;
  }
}
