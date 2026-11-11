import { classifyClaudeLine } from "../classifyRateLimit.js";
import type { ExecutionOutcome } from "./types.js";
import type { SpawnRunResult } from "./spawnRun.js";

export interface Interpreted {
  sessionId: string | null;
  outcome: ExecutionOutcome;
}

const RATE_LIMIT_RE = /usage limit|rate[ _]limit/i;
const AUTH_RE = /not logged in|unauthoriz|authentication fail|\b401\b/i;
const CONTEXT_RE = /context window|context length|too long for the model|token limit exceeded/i;
const PERMISSION_RE = /permission|approval|denied access|sandbox denied/i;

function spawnFailureOutcome(result: SpawnRunResult): Interpreted | null {
  if (result.spawnError) {
    return { sessionId: null, outcome: { kind: "crashed", detail: result.spawnError.message, cooldownResetsAt: null } };
  }
  if (result.timedOut) {
    return { sessionId: null, outcome: { kind: "timed_out", detail: "execution exceeded its configured timeout", cooldownResetsAt: null } };
  }
  return null;
}

/**
 * Classifies a `codex exec --json` run. Codex's event stream carries no
 * structured rate-limit/auth/context field (see docs/FEASIBILITY.md
 * Phase 0 #14 for the same limitation on plain usage classification) —
 * so, same as there, this is necessarily free-text matching on the
 * `error`/`turn.failed` message body, not a structured signal. No
 * cooldown timestamp is extracted for the same reason: Codex's own
 * message is a human sentence ("...try again at 10:03 AM"), not a
 * parseable timestamp.
 */
export function interpretCodexRun(result: SpawnRunResult): Interpreted {
  const failure = spawnFailureOutcome(result);
  if (failure) return failure;

  let sessionId: string | null = null;
  let sawTurnCompleted = false;
  let sawAnyItem = false;

  for (const event of result.events) {
    const obj = event.raw as { type?: unknown; thread_id?: unknown; message?: unknown; error?: { message?: unknown } };
    if (typeof obj.thread_id === "string") sessionId = obj.thread_id;
    if (obj.type === "turn.completed") sawTurnCompleted = true;
    if (obj.type === "item.completed" || obj.type === "item.started") sawAnyItem = true;

    const message = typeof obj.message === "string" ? obj.message : obj.error?.message;
    if (typeof message !== "string") continue;

    if (RATE_LIMIT_RE.test(message)) return { sessionId, outcome: { kind: "rate_limited", detail: message, cooldownResetsAt: null } };
    if (AUTH_RE.test(message)) return { sessionId, outcome: { kind: "auth_failed", detail: message, cooldownResetsAt: null } };
    if (CONTEXT_RE.test(message)) return { sessionId, outcome: { kind: "context_exhausted", detail: message, cooldownResetsAt: null } };
    if (PERMISSION_RE.test(message)) return { sessionId, outcome: { kind: "permission_required", detail: message, cooldownResetsAt: null } };
  }

  // Checked after the loop (so a session id already revealed before
  // cancellation is still carried forward for a later resume) but ahead
  // of "completed"/"crashed" — a daemon-requested pause/stop (Phase 4)
  // must never be misreported as either.
  if (result.cancelled) return { sessionId, outcome: { kind: "cancelled", detail: result.cancelReason, cooldownResetsAt: null } };
  if (sawTurnCompleted) return { sessionId, outcome: { kind: "completed", detail: null, cooldownResetsAt: null } };
  if (result.exitCode !== 0) {
    return {
      sessionId,
      outcome: { kind: "crashed", detail: `codex exited with code ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ""}: ${result.stderr.trim().slice(0, 500)}`, cooldownResetsAt: null },
    };
  }
  if (!sawAnyItem) {
    return { sessionId, outcome: { kind: "invalid_output", detail: "codex exited 0 but produced no recognizable event", cooldownResetsAt: null } };
  }
  return { sessionId, outcome: { kind: "unknown_error", detail: "codex exited 0 without a turn.completed event", cooldownResetsAt: null } };
}

/**
 * Classifies a `copilot -p --output-format json` run. **Best-effort,
 * unverified** — this project has not yet captured a real completed or
 * failed sample of Copilot's JSONL event stream (docs/MULTI_AGENT.md),
 * so classification deliberately relies only on what's independently
 * confirmed to exist regardless of event field names: the process's own
 * exit code and stderr text, matched against the same regexes Codex's
 * classifier already uses. This never scans raw event JSON for these
 * patterns (Phase 2C's own history: that produced false positives for
 * Claude when a field name itself matched) — only `result.stderr`.
 * `events` is still populated generically by `spawnRun` (every stdout
 * line that parses as JSON), so nothing about this adapter's output is
 * lost; a session id is opportunistically read from a `session_id` or
 * `id` field on any event, best-effort, never required.
 */
export function interpretCopilotRun(result: SpawnRunResult): Interpreted {
  const failure = spawnFailureOutcome(result);
  if (failure) return failure;

  let sessionId: string | null = null;
  for (const event of result.events) {
    const obj = event.raw as { session_id?: unknown; id?: unknown };
    if (typeof obj.session_id === "string") sessionId = obj.session_id;
    else if (typeof obj.id === "string" && sessionId === null) sessionId = obj.id;
  }

  if (result.exitCode === 0) {
    if (result.events.length === 0) {
      return { sessionId, outcome: { kind: "invalid_output", detail: "copilot exited 0 but produced no parseable JSON event", cooldownResetsAt: null } };
    }
    return { sessionId, outcome: { kind: "completed", detail: null, cooldownResetsAt: null } };
  }

  const stderr = result.stderr.trim();
  if (RATE_LIMIT_RE.test(stderr)) return { sessionId, outcome: { kind: "rate_limited", detail: stderr.slice(0, 500), cooldownResetsAt: null } };
  if (AUTH_RE.test(stderr)) return { sessionId, outcome: { kind: "auth_failed", detail: stderr.slice(0, 500), cooldownResetsAt: null } };
  if (CONTEXT_RE.test(stderr)) return { sessionId, outcome: { kind: "context_exhausted", detail: stderr.slice(0, 500), cooldownResetsAt: null } };
  if (PERMISSION_RE.test(stderr)) return { sessionId, outcome: { kind: "permission_required", detail: stderr.slice(0, 500), cooldownResetsAt: null } };
  return { sessionId, outcome: { kind: "crashed", detail: `copilot exited with code ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ""}: ${stderr.slice(0, 500)}`, cooldownResetsAt: null } };
}

/**
 * Classifies a `claude -p --output-format stream-json` run. Unlike
 * Codex, Claude's `rate_limit_event` is structured (see
 * docs/FEASIBILITY.md Phase 1B), so a cooldown timestamp IS extracted
 * when that event was present. Permission-required detection is
 * best-effort text matching, same caveat as Phase 2A §4's observed
 * real string ("I need permission to write the file...") — Claude
 * surfaces this as ordinary assistant text, not a distinct event type.
 */
export function interpretClaudeRun(result: SpawnRunResult): Interpreted {
  const failure = spawnFailureOutcome(result);
  if (failure) return failure;

  let sessionId: string | null = null;
  let cooldownResetsAt: number | null = null;
  let sawRateLimitExhausted = false;
  let sawResult = false;
  let isError = false;
  let resultText = "";

  for (const event of result.events) {
    const rateLimit = classifyClaudeLine(event.raw);
    if (rateLimit?.classification === "exhausted") {
      sawRateLimitExhausted = true;
      if (rateLimit.primary?.resetsAt) cooldownResetsAt = rateLimit.primary.resetsAt;
    }

    const obj = event.raw as { type?: unknown; session_id?: unknown; is_error?: unknown; result?: unknown; subtype?: unknown };
    if (typeof obj.session_id === "string") sessionId = obj.session_id;
    if (obj.type === "result") {
      sawResult = true;
      isError = obj.is_error === true;
      if (typeof obj.result === "string") resultText = obj.result;
    }
  }

  // Only `resultText` (the assistant-facing text) is matched against these
  // regexes — unlike Codex's stream, Claude's raw events carry field names
  // like `rate_limit_event`/`rate_limit_info` that would otherwise produce
  // false positives on every single run, limited or not. The *structural*
  // rate-limit signal (`sawRateLimitExhausted`, from `classifyClaudeLine`)
  // is checked separately and takes priority.
  if (sawRateLimitExhausted || RATE_LIMIT_RE.test(resultText)) {
    return { sessionId, outcome: { kind: "rate_limited", detail: resultText || "rate limit indicated", cooldownResetsAt } };
  }
  if (AUTH_RE.test(resultText)) return { sessionId, outcome: { kind: "auth_failed", detail: resultText || "authentication failure indicated", cooldownResetsAt: null } };
  if (CONTEXT_RE.test(resultText)) return { sessionId, outcome: { kind: "context_exhausted", detail: resultText || "context exhaustion indicated", cooldownResetsAt: null } };
  if (PERMISSION_RE.test(resultText)) return { sessionId, outcome: { kind: "permission_required", detail: resultText || "permission required", cooldownResetsAt: null } };

  // See the matching comment in interpretCodexRun on ordering/why.
  if (result.cancelled) return { sessionId, outcome: { kind: "cancelled", detail: result.cancelReason, cooldownResetsAt: null } };
  if (sawResult && !isError) return { sessionId, outcome: { kind: "completed", detail: null, cooldownResetsAt: null } };
  if (sawResult && isError) return { sessionId, outcome: { kind: "unknown_error", detail: resultText || "claude reported an error result", cooldownResetsAt: null } };
  if (result.exitCode !== 0) {
    return {
      sessionId,
      outcome: { kind: "crashed", detail: `claude exited with code ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ""}: ${result.stderr.trim().slice(0, 500)}`, cooldownResetsAt: null },
    };
  }
  return { sessionId, outcome: { kind: "invalid_output", detail: "claude exited 0 but produced no `result` event", cooldownResetsAt: null } };
}
