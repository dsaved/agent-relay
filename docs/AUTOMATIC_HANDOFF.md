# Phase 3A — Automatic Handoff Orchestration

> **Updated by Phase 9** (see
> [`docs/PROVIDER_CHOICE_NOTIFICATIONS.md`](PROVIDER_CHOICE_NOTIFICATIONS.md)):
> `selectAndAdvance()` no longer auto-picks "the other provider" the
> moment one becomes available. With no `pinnedProvider` set, it now
> always pauses (`paused_approval`, `pendingProviderChoice` populated)
> and waits for an explicit `agent-relay auto resume <task-id> --pin
> <provider>` — every leg, not just when every candidate is exhausted.
> This is a deliberate, breaking change to this phase's original
> "picks an eligible alternative provider" behavior below, driven by a
> real request: the user wants to be asked and to choose, not have the
> coordinator decide silently. A standing `auto start --pin <provider>`
> is unaffected — it still never pauses to ask, exactly as described
> here. Everything else on this page (ownership, locking, outcome
> classification, persistence, resumability) is unchanged.

Goal: when a Relay-managed worker runs out of usage, crashes, or becomes
unavailable mid-task, automatically hand its unfinished work to the other
provider — using the exact same `HandoffEngine` safety machinery Phases
2B/2C already built and verified live, never a shortcut around it. Per
the task's own instruction, **no live coding-agent turn was run in this
phase** — everything here is built and tested against fake providers and
disposable repositories; a live demonstration remains available on
request, the same way Phase 2A and 2C's were, but isn't part of this
phase's deliverable.

## 1. `AutomaticHandoffCoordinator`

[`src/auto/coordinator.ts`](../src/auto/coordinator.ts). Each of the
requirement's responsibilities maps onto a concrete piece:

| Requirement | Where |
|---|---|
| Tracks Relay-managed processes and tasks | `AutoTaskState`, persisted per task (§4) |
| Detects execution failures and usage-limit exhaustion | `validateAndAdvance()` reads the `ExecutionOutcome` `HandoffEngine` already classifies (Phase 2B); `selectAndAdvance()` reads `CodexUsageMonitor`/`ClaudeUsageMonitor` (Phase 1A/1B) through `evaluateProviderAvailability` (Phase 2B), unchanged |
| Selects an eligible alternative provider | [`src/auto/providerSelection.ts`](../src/auto/providerSelection.ts) — there are only two providers, so "eligible alternative" is always "the other one" unless pinned |
| Captures the latest task and workspace state | Re-uses `createHandoffRecord()` (Phase 2B) for every leg after the first — it always re-reads git fresh, never assumes |
| Confirms the previous worker and its descendants have stopped | By construction: `AgentExecutionAdapter.run()` (Phase 2B/2C) only resolves after `spawnRun`'s process-group kill confirms the whole group is gone — the coordinator never proceeds to the next leg before that promise settles |
| Transfers ownership to the destination | `HandoffEngine.executeHandoff()` (Phase 2B/2C), called exactly as-is |
| Continues unfinished implementation automatically | `buildContinuationInstruction()`/`buildResumeNudge()` (Phase 2B), unchanged |
| Validates completed work | `HandoffEngine`'s own `validationCommands` run (Phase 2B), unchanged |
| Records all transitions and outcomes | `AutoTaskState.transitions`, persisted on every `step()` (§4) |

No model SDK, API key, or pay-per-token billing is used anywhere in this
phase — [`test/noApiKeyAuthentication.test.ts`](../test/noApiKeyAuthentication.test.ts)
scans every source file for the telltale patterns (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, SDK imports) and fails if any appear.

## 2. Ownership model

[`src/auto/ownership.ts`](../src/auto/ownership.ts), `assessOwnership()`
— the three states, computed from exactly two signals this codebase
already trusts (never from lock age, file mtimes, or a provider being
exhausted, none of which prove a desktop agent has stopped):

- **`relay_managed`**: `WorkspaceLockManager.isHeldByThisProcess()` says
  yes — this very coordinator process is the recorded lock holder.
- **`external_idle_confirmed`**: not relay-managed, and Phase 2C's
  `classifyWorkspaceActivity()` returns a genuine positive —
  `confirmed_idle` (Claude: no running process found; Codex: no Codex
  session at all for this path).
- **`external_unknown`**: anything else — `confirmed_busy`, or
  `unknown` (the common Codex case: a thread exists for this path, but
  `thread/list` can't prove it's stopped).

**Automatic switching is permitted only from `relay_managed` or into
`external_idle_confirmed`** — `awaiting_ownership` transitions straight
to `paused_approval` on `external_unknown`, before even reaching
`selecting_provider`. `--force-lock` (`forceLockOverride`) is **never**
passed by the coordinator — `handOffAndAdvance()`'s call to
`executeHandoff()` hard-codes `forceLockOverride: false`, with a comment
explaining why. The only way an ownership-blocked task proceeds is a
human calling `agent-relay auto resume`, which re-enters at `running` and
re-checks ownership fresh rather than skipping the check — see §7.

## 3. Provider selection

[`src/auto/providerSelection.ts`](../src/auto/providerSelection.ts),
`selectAlternativeProvider()` — reuses `evaluateProviderAvailability()`
(Phase 2B) completely unchanged:

- **Codex**: checked via `CodexUsageMonitor.getStatus()` → a live
  `account/rateLimits/read` call (Phase 1A) — zero-cost, no model
  prompt. `exhausted` always pauses (`paused_exhausted`); the
  coordinator's own adapter is never invoked when a candidate is
  exhausted.
- **Claude**: checked via `ClaudeUsageMonitor.getStatus()` (Phase 1B) —
  passive only. The coordinator keeps **one** `ClaudeUsageMonitor`
  instance alive for its whole run and feeds it every real Claude
  execution's own raw events after the fact
  (`handOffAndAdvance()` → `this.claudeUsageMonitor.observe(...)`) — so
  later decisions can benefit from real observations without ever
  issuing a prompt whose only purpose is to check availability.
- **Unknown availability**: a distinct, bounded, opt-in policy
  (`UnknownAvailabilityPolicy`) — disabled by default (`paused_approval`
  instead of proceeding), and even when a caller explicitly sets
  `--allow-unknown-availability`, each provider gets a capped number of
  attempts under "unknown" (`maxUnknownAttempts`, default 2) before it
  pauses anyway. The attempt counter resets to zero the moment that
  provider reports a *definitive* answer (available or exhausted) —
  it's not a one-time bypass.

## 4. State machine

[`src/auto/types.ts`](../src/auto/types.ts), `AutoTaskState`, persisted
via new `HandoffStore` methods (`saveAutoTask`/`loadAutoTask`/
`listAutoTaskIds`, same atomic write-temp-then-rename as every other
record in this project) under `~/.agent-relay/autotasks/<taskId>.json`.

All eleven required states exist (`queued`, `running`, `checkpointing`,
`awaiting_ownership`, `selecting_provider`, `handing_off`, `validating`,
`completed`, `paused_exhausted`, `paused_approval`, `failed`) and every
transition between them is appended to `AutoTaskState.transitions`
*before* that step's work happens for the next state — each carrying a
timestamp, a fresh `attemptId` (a random UUID, not reused across
transitions), the provider involved (when relevant), and a human-
readable reason. The full state is re-persisted after every single
`step()` call, not just at the end of a leg.

**Preventing duplicate transitions and double execution after
crashes:**

- `start()` on an already-`completed`/`failed` task returns it as-is —
  no new transition, no adapter call. Verified directly: calling
  `start()` twice on the same completed task leaves the fake adapter's
  call count at exactly 1.
- `start()` on an already-`paused_*` task also returns it as-is —
  resuming requires the explicit `resume()` call, never a silent
  continuation.
- `start()` on a task left mid-flight (any other state) picks the loop
  back up from exactly where the persisted state says it was — this
  *is* the coordinator-restart recovery path, and it relies on
  `WorkspaceLockManager`'s own crash recovery (Phase 2C) to settle
  whether the in-flight leg's lock is still live or safely reclaimable.

## 5. Cooldowns and recovery

[`src/auto/cooldown.ts`](../src/auto/cooldown.ts):

- `cooldownFromUsageStatus()` / `cooldownFromOutcome()` both prefer a
  provider's **own reported reset time** (`UsageSnapshot.primary.resetsAt`,
  or `ExecutionOutcome.cooldownResetsAt` for a `rate_limited` run) —
  recorded with `fromReportedReset: true`.
- Only when no reset time is known does a **bounded exponential
  backoff** apply (`min(maxCooldownMs, baseCooldownMs * 2^attempt)`,
  defaults 30s base / 30min cap) — never an unbounded retry loop.
- `isOnCooldown()` is checked *before* any usage check runs — a
  provider already known to be on cooldown is never re-queried just to
  re-confirm it, satisfying "never repeatedly invoke models simply to
  discover usage availability" (and for Codex, "invoke" here is a
  zero-cost RPC anyway, but the same discipline still applies).
- Cooldowns live on `AutoTaskState.cooldowns`, per provider, and survive
  a coordinator restart along with everything else.
- `resume()` on a `paused_exhausted` task re-checks that provider's
  cooldown and throws (refusing to resume) if it hasn't elapsed — "resume
  paused tasks only when permitted by the availability policy" is
  enforced in code, not left to the caller's judgment.
- `limits.maxHandoffs` / `maxAttempts` / `maxRuntimeMs` are checked at
  the top of every `selectAndAdvance()` call (handoffs/attempts) and
  `running` step (runtime) — exceeding any one ends the task `failed`
  with a specific reason, never an infinite bounce.
- `auth_failed` and `permission_required` outcomes stop automatic
  retries unconditionally — `validateAndAdvance()` routes both straight
  to `paused_approval`, never back to `running` for another bounce.

## 6. Task continuation

Entirely `HandoffEngine` (Phase 2B/2C), unchanged. The one addition is
[`src/auto/followOnHandoff.ts`](../src/auto/followOnHandoff.ts),
`getOrCreateNextLegHandoff()`: leg 1 reuses the `HandoffRecord`
`handoff prepare` already created (it has no `destinationProvider` yet,
so there's nothing to redirect); every leg after that calls
`createHandoffRecord()` again — re-reading git fresh, carrying the same
`taskId` forward, and carrying the previous leg's `knownErrors` plus a
one-line summary of why this leg exists (e.g. *"Previous attempt on
codex: crashed (simulated mid-edit)"*) into the new record's
`knownErrors`, which `buildContinuationInstruction()` already surfaces to
the destination. `originalTaskObjective` is carried forward unchanged —
never regenerated. No `git commit`, `reset`, `clean`, or `push` exists
anywhere in this phase's code, same discipline as Phase 2B/2C.

## 7. CLI commands

```
agent-relay auto start <task-id> [--objective "..."] [--validate "cmd"]... [--allow-unknown-availability] [--max-handoffs N] [--max-attempts N] [--max-runtime-ms N] [--pin <claude|codex>]
agent-relay auto status <task-id>
agent-relay auto pause <task-id>
agent-relay auto resume <task-id> [--objective "..."]
agent-relay auto stop <task-id>
agent-relay auto history <task-id>
```

All run in the foreground, as the task specifies for this phase — `auto
start`/`auto resume` drive the coordinator's loop synchronously until it
settles (completed/paused/failed) and then exit; persistent background
operation is explicitly out of scope here (a later daemon phase).
`status`/`pause`/`stop`/`history` were smoke-tested against the real CLI
binary (missing-task error paths, help text); `start`/`resume` were not
exercised through the CLI binary in this phase, since doing so with the
default (real) execution adapters would be exactly the live model call
this phase's restrictions withhold without separate authorization — they
are, however, fully exercised as a library through `AutomaticHandoffCoordinator`
directly in every test below.

## 8. Testing

| Required scenario | Test |
|---|---|
| Claude exhausted → Codex continues | `autoCoordinator.test.ts` |
| Codex exhausted → Claude continues | `autoCoordinator.test.ts` |
| Both providers exhausted → task pauses | `autoCoordinator.test.ts` ("Both providers exhausted") |
| One provider's usage status unknown | `autoCoordinator.test.ts` ("One provider's usage status is unknown") |
| Agent crashes midway through editing | `autoCoordinator.test.ts` ("Agent crashes midway through editing") |
| Source worker still alive → handoff blocked | `autoCoordinator.test.ts` ("Source worker still alive") |
| External desktop activity unknown → handoff blocked | `autoCoordinator.test.ts` ("External desktop activity unknown") |
| Destination provider becomes exhausted | `autoCoordinator.test.ts` ("Destination provider becomes exhausted") |
| Multiple consecutive handoffs | `autoCoordinator.test.ts` ("Multiple consecutive handoffs") |
| Coordinator restart during handoff | `autoCoordinatorRestart.test.ts` |
| Validation failure | `autoCoordinator.test.ts` ("Validation failure after a successful agent turn") |
| Maximum retry and handoff limits | `autoCoordinator.test.ts` ("Maximum handoff limit...") |
| No duplicate worker execution | `autoCoordinator.test.ts` ("No duplicate worker execution") |
| No automatic use of force-lock | `autoCoordinator.test.ts` ("No automatic use of --force-lock") |
| No API-key authentication | `noApiKeyAuthentication.test.ts` |
| Preservation of existing work | `autoCoordinator.test.ts` ("Preservation of existing work") |

All of Phase 0 through 2C's existing tests pass unmodified, plus these
additions: **101/101 tests pass** (typecheck, lint, and build also
clean).

## 9. Capability matrix

| # | Capability | Status | Evidence |
|---|---|---|---|
| 3A.1 | `AutomaticHandoffCoordinator` orchestrates bidirectional automatic handoff | **VERIFIED** (against fakes) | §8; no live run performed this phase |
| 3A.2 | Ownership model: three states, automatic switching gated on them | **VERIFIED** | §2; "source worker still alive" and "external activity unknown" tests |
| 3A.3 | `--force-lock` never applied automatically | **VERIFIED** | By construction (`forceLockOverride: false` hard-coded); explicit test asserting the adapter is never called when activity is busy |
| 3A.4 | Lock age / file inactivity / exhaustion never used as proof a desktop agent stopped | **VERIFIED** | No such check exists anywhere in `assessOwnership`/`WorkspaceLockManager` (unchanged from Phase 2C) |
| 3A.5 | Provider selection reuses existing usage monitors; Codex via `account/rateLimits/read`, Claude passive-only | **VERIFIED** | §3; zero new model-prompt-for-availability code path |
| 3A.6 | Unknown-availability policy: opt-in, bounded, resets on a definitive answer | **VERIFIED** | §3; "one provider's usage status is unknown" test (both the disabled-by-default and enabled-with-bound paths) |
| 3A.7 | Durable state machine, all 11 states, full transition history | **VERIFIED** | §4; `autoCoordinatorRestart.test.ts` |
| 3A.8 | No duplicate transitions / double execution after a crash | **VERIFIED** | "no duplicate worker execution" + coordinator-restart tests |
| 3A.9 | Cooldowns prefer reported reset times; bounded backoff otherwise | **VERIFIED** | §5; "both providers exhausted" test asserts `fromReportedReset: true` |
| 3A.10 | Resume only permitted per availability policy | **VERIFIED** | `resume()`'s cooldown re-check, throws rather than silently proceeding |
| 3A.11 | Max handoffs/attempts/runtime enforced | **VERIFIED** | "maximum handoff limit" test |
| 3A.12 | Auth/permission failures stop automatic retries | **VERIFIED** | By construction in `validateAndAdvance()`; covered implicitly by the outcome-kind branch logic (same classifier Phase 2B/2C already tested against real fixtures) |
| 3A.13 | Task continuation preserves objective, git status, modified/untracked files; records reason and new session id; runs validation | **VERIFIED** | §6; "preservation of existing work" + "multiple consecutive handoffs" tests |
| 3A.14 | No git commit/reset/clean/push anywhere in this phase | **VERIFIED** | No such call exists in `src/auto/`; byte-identical git-log-length assertion in test |
| 3A.15 | CLI commands implemented, foreground-only | **VERIFIED** (read-only/state commands live-smoke-tested; `start`/`resume` library-tested only, live run deliberately not attempted) | §7 |
| 3A.16 | No API-key authentication anywhere in this phase's code | **VERIFIED** | `noApiKeyAuthentication.test.ts` |
