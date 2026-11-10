# Phase 3B — Desktop Session Integration and Safe Ownership Transfer

Goal: let a task started in Codex Desktop or Claude Desktop (Code tab) be
discovered, tracked in a durable registry, and — only when real evidence (not
a guess, not a stale lock, not a past approval) supports it — safely handed
to the other provider's subscription-authenticated CLI, continuing through
the exact same `HandoffEngine`/`AutomaticHandoffCoordinator` Phases 2B/2C/3A
already built and verified. Nothing in Phases 0–3A was changed; this phase
only adds a new, separate desktop-specific layer on top. All 101 pre-existing
tests pass unmodified (see the verification run at the end).

## 1. Desktop session tracking

[`src/desktop/types.ts`](../src/desktop/types.ts)'s `DesktopSessionRecord`,
persisted one-file-per-session under `~/.agent-relay/desktop-sessions/`
(same atomic write-temp-then-rename `HandoffStore` has used for every other
record type since Phase 2B — three new methods, `saveDesktopSession`/
`loadDesktopSession`/`listDesktopSessionIds`, no new persistence mechanism).
Captures exactly the required fields: provider, session/thread id, repo root
+ worktree path (reusing Phase 2A's `detectWorktreeInfo` via the session's
own `SessionAssociation`), originating application (best-effort — see §3/§4),
observed activity state and when it was last confirmed (Phase 2C's own
tri-state `ActivityStatus`), the associated task id, the ownership status
(§2), and an append-only `evidence` audit trail.

[`src/desktop/registry.ts`](../src/desktop/registry.ts)'s `DesktopRegistry`
never merges two sessions into one record just because they share a
`repoRoot` — each discovered session/thread id gets its own record, same
rule `projectAssociation.ts`'s `groupByProject` already enforces (verified:
`test/desktopRegistry.test.ts`, "two sessions sharing a repoRoot register as
two distinct records, never merged"). `classifyWorkspaceActivity` (Phase 2C)
is reused unchanged, so the existing rule holds here too: ordinary Codex
thread history is never read as proof of an active — or stopped — process.

## 2. Ownership transfer — a new, separate 7-state model

**Deliberate design choice:** this phase does **not** rename or extend Phase
3A's existing `OwnershipState` (`relay_managed`/`external_idle_confirmed`/
`external_unknown` in `src/auto/types.ts`), which keeps governing the
already-verified leg-to-leg bounce inside `AutomaticHandoffCoordinator`
untouched. Instead, [`src/desktop/types.ts`](../src/desktop/types.ts) defines
a separate `DesktopOwnershipState` for the new desktop-registration path:

```
external_unmanaged   external_active   external_unknown
handoff_requested     relinquished      relay_owned      released
```

[`src/desktop/ownership.ts`](../src/desktop/ownership.ts)'s
`assessDesktopOwnership()` is a pure function of exactly four real signals —
nothing cached, nothing inferred from the past:

1. `heldByThisProcess` — `WorkspaceLockManager.isHeldByThisProcess()`.
2. `activitySignal` — Phase 2C's `classifyWorkspaceActivity()`, freshly run.
3. `handoffAuthorizedNow` — true **only** on the exact call that is itself a
   user's explicit `agent-relay desktop handoff ... --to` invocation.
4. `sourceProcessGroupTerminated` — spec condition #3: the recorded lock
   holder was a Relay worker whose process is now genuinely dead (a new
   `WorkspaceLockManager.wasRelayWorkerThatHasTerminated()` read, reusing the
   existing `isPidAlive` check — no new liveness mechanism).

A workspace becomes `relay_owned` only when (1) is true, or when (3) is true
*and* either the fresh activity check confirms idle or (4) holds — i.e.
exactly the spec's three allowed conditions, never more. Critically, a past
`handoff_requested` authorization is **never** reused as standing permission:
every call that isn't itself an authorizing call re-derives the state from
current evidence only (`test/desktopOwnership.test.ts`, "a PAST
handoff_requested authorization is never reused..."). `--force-lock` is not a
parameter this function even knows about — forcing stays an explicit,
separate, per-call CLI choice, exactly like Phase 2C's existing rule.

`released` is set directly by the handoff glue (§6) at the moment a workspace
lock is cleanly given back, not re-derived by the pure function — the next
assessment after that re-evaluates from scratch, same "never treat a past
event as standing proof" principle.

## 3. Codex Desktop integration

No new mechanism was built or needed here — Phase 0/2A already answered this
phase's actual questions, and this phase doesn't reopen them:

- `thread/list` (reused via `discoverCodexSessions`, unchanged) is a read of
  persisted thread metadata, not a live process table — it cannot prove a
  thread has stopped (docs/SESSION_DISCOVERY.md §1).
- `account/rateLimits/read` (reused via `CodexUsageMonitor`, unchanged) is
  the already-built, zero-cost, account-level signal — and it stays exactly
  that: account-level, never treated as proof of this *workspace's*
  inactivity (§8 below).
- No undocumented socket (`~/.codex/app-server-control/app-server-control.sock`,
  `~/.codex/ipc/ipc.sock`) is touched anywhere in this phase's code, same as
  every prior phase.

Consequence, stated plainly, same as Phase 2C: a Codex-desktop-originated
session's liveness defaults to `external_unknown` (via `classifyWorkspaceActivity`'s
existing Codex policy) unless and until a user explicitly runs `desktop
handoff` and the evidence genuinely supports one of the three allowed
conditions. This phase does not — and, per the task's own §3 restriction on
undocumented IPC, cannot — change that.

## 4. Claude Desktop integration

- Discovery: `discoverClaudeSessions` (`claude agents --json`), reused
  unchanged.
- **Hooks** (new): Claude Code's documented hook events (`SessionStart`,
  `Stop`, `SubagentStop`, `Notification`, `PreToolUse`/`PostToolUse`, etc.)
  are shell commands the user configures in their own `~/.claude/settings.json`,
  each invoked with a JSON payload (`session_id`, `hook_event_name`, `cwd`,
  ...) on stdin. [`src/desktop/registry.ts`](../src/desktop/registry.ts)'s
  `parseHookEvent()` parses that payload (never throws — malformed input is
  reported, not an exception; `test/hookEvent.test.ts`), and a new CLI
  command, `agent-relay desktop hook-event`, reads one such payload per line
  from stdin and appends it as an evidence entry on the matching registered
  session (or reports it as ignored, if that session was never registered —
  this phase never assumes every desktop conversation exposes these events).
  This is passive logging only: it never spawns a model call, satisfying "do
  not generate model prompts solely to inspect subscription availability."

  **This phase does not edit the user's real `~/.claude/settings.json`.**
  Wiring a hook into it is a standing-configuration change this session's
  own rules require explicit permission for. To wire it in manually, add
  (e.g. for the `Stop` event):

  ```json
  {
    "hooks": {
      "Stop": [{ "hooks": [{ "type": "command", "command": "agent-relay desktop hook-event" }] }]
    }
  }
  ```

- Rate-limit/exhaustion signals: `ClaudeUsageMonitor`, reused unchanged — fed
  passively from real session output, never probed (§8 below).

## 5. Desktop task association — CLI commands

```
agent-relay desktop register <session-id> --objective "..."
agent-relay desktop sessions
agent-relay desktop inspect <session-id>
agent-relay desktop handoff <session-id> --to <claude|codex> [--force-lock] [--validate "cmd"]...
agent-relay desktop hook-event
```

`register` requires an objective when the discovered session has no title of
its own (`MissingObjectiveError`) — it is never invented
(`test/desktopRegistry.test.ts`). All associations are durable
(`~/.agent-relay/desktop-sessions/`), surviving process restarts the same way
every other record in this store does.

## 6. Desktop-to-CLI continuation

[`src/desktop/handoff.ts`](../src/desktop/handoff.ts)'s
`requestDesktopHandoff()` is a thin glue function, not a new execution
engine, per the task's own restriction:

1. `registry.refreshOwnership(sessionId, authorizeNow: true)` — assesses
   fresh (§2); this call is itself the user's explicit authorization.
2. If the evidence doesn't support taking ownership and `--force-lock` was
   not explicitly passed on this call, refuse — `HandoffEngine` is never
   even invoked (verified: `test/desktopHandoff.test.ts`, "blocked before
   HandoffEngine is ever called").
3. Otherwise, `registry.ensureTask()` (reusing `createHandoffRecord`, exactly
   as `handoff prepare` already does) and `HandoffEngine.executeHandoff()`
   (exactly as `handoff execute` already does) — same workspace lock, same
   usage gating, same outcome classification, same validation-command
   running, same "never commit/reset/clean/push" guarantee.
4. On a non-blocked outcome, the workspace lock has already been released by
   `HandoffEngine`'s own `finally` block by the time this resolves;
   `registry.markReleased()` records that as `released` evidence.

## 7. Desktop-originated session verification

No tool available in this environment can open or drive an actual Codex
Desktop or Claude Desktop GUI window — this is a hard environment
limitation, not a design choice, and is handled exactly as Phase 2A handled
the analogous limitation it hit (docs/SESSION_DISCOVERY.md §5):

- **Discovery, association, ownership-transfer, rejection-of-unsafe-takeover,
  and crash-recovery are all VERIFIED against fakes** — a fake
  `DiscoveredSession`/`SessionAssociation` shaped like a real Desktop-
  originated one (`discoverySource` carrying `"(vscode / Codex Desktop)"`,
  etc.), a disposable repo, and a disposable store root
  (`test/desktopRegistry.test.ts`, `test/desktopOwnership.test.ts`,
  `test/desktopHandoff.test.ts`, `test/hookEvent.test.ts` — 30 new tests).
- **Read-only discovery against a real, currently-live Claude Desktop
  Code-tab session is safe and was already demonstrated in Phase 2A** (its
  own evidence item #11) — this phase adds nothing new to probe here, and
  does not attempt to register, transfer, or resume against any live session,
  exactly as Phase 2A §5 and this task's own restrictions require.
- **Preservation of unfinished code and desktop-to-CLI continuation** are
  VERIFIED against fakes (`test/desktopHandoff.test.ts`, "a prior
  registration's objective is what HandoffEngine receives — never invented"),
  reusing the exact same `HandoffEngine` machinery Phase 2C already verified
  live for the CLI-to-CLI case.
- **An actual live model turn proving end-to-end desktop-to-CLI continuation
  (mirroring Phase 2A §4/2C's live run) was not run in this phase** — that
  needs a separate, explicit go-ahead, the same gate every live run in this
  project has gone through.
- Per the task's own instruction: capabilities that could not be verified
  under these constraints are marked `UNVERIFIED`/`UNSUPPORTED` below, not
  glossed over.

## 8. Automatic exhaustion detection

No new monitoring code. `CodexUsageMonitor`/`ClaudeUsageMonitor` (Phase
1A/1B) are reused exactly as-is. The only new logic is reporting: `desktop
inspect` can be read alongside `usage codex`/`usage claude` to correlate an
exhaustion event with a registered session's `associatedTaskId` — and, same
as every phase before this one, exhaustion is never treated as evidence of
workspace inactivity. No exception to that rule exists anywhere in this
phase's code.

## 9. Coordinator hardening — reviewed, not modified

`src/auto/coordinator.ts` (Phase 3A) was reviewed against every item in the
spec's list and is **unmodified** — each concern is already satisfied by
code this phase reuses as-is, or belongs to the new desktop path instead of
the existing supervised loop:

| Concern | Status |
|---|---|
| Old Codex session history blocking Relay-owned workers | Already satisfied — `classifyWorkspaceActivity`'s Codex policy (Phase 2C), unchanged; the new desktop path adds the identical discipline via `assessDesktopOwnership` |
| Workspace lock recovery across processes | Already satisfied — PID-liveness in `WorkspaceLockManager.acquire()` (Phase 2C), reused directly by the new `wasRelayWorkerThatHasTerminated()` |
| Duplicate execution after restarts | Already satisfied for the supervised loop (Phase 3A's `start()`); the new `desktop handoff` path isn't a loop — it's a single explicit action like `handoff execute`, and its own idempotency comes from `ensureTask()` reusing the same task/handoff on a second call plus `HandoffEngine`'s existing resumable-attempt logic (verified: `test/desktopRegistry.test.ts` "ensureTask()... reuses it on later calls") |
| Atomic state transitions | Already satisfied — `HandoffStore`'s write-temp-then-rename, reused unchanged for the new record type |
| Pause and stop requests during running execution | Applies to `AutomaticHandoffCoordinator`'s supervised loop, unchanged. A single `desktop handoff` call has no separate pause/stop of its own — same as `handoff execute` always has — only `spawnRun.ts`'s existing timeout/SIGTERM→SIGKILL |
| External desktop activity beginning after a handoff request | **Caught, newly, by design**: `requestDesktopHandoff()` never trusts a stored `handoff_requested` state — every call re-runs `refreshOwnership()` fresh, and `HandoffEngine` re-checks activity again independently at lock-acquire time (verified: "a PAST handoff_requested authorization is never reused...") |
| Manual desktop edits occurring while a Relay worker is active | **Honestly documented gap, not built around**: once a lock is held, a second Relay-initiated acquisition is refused, but there is no file-level mechanism stopping a human from editing files by hand in their own desktop app while a spawned CLI process is also writing — building one would need the kind of polling watchdog or second execution path §6 explicitly rules out. Same spirit as Phase 2C's own stated PID-reuse limitation: honestly flagged, not silently assumed safe |

## 10. Tests and deliverables

30 new tests, all against fakes/disposable repos — no live model call or real
Desktop GUI window anywhere in this phase:

| Area | File |
|---|---|
| 7-state ownership decision table | `test/desktopOwnership.test.ts` |
| Registration, evidence, task association, originating-app inference | `test/desktopRegistry.test.ts` |
| End-to-end desktop handoff (blocked/allowed/force-lock/objective fidelity) | `test/desktopHandoff.test.ts` |
| Hook JSON parsing + evidence recording | `test/hookEvent.test.ts` |

Deliverables: `src/desktop/{types,ownership,registry,handoff,format}.ts`;
`agent-relay desktop {register,sessions,inspect,handoff,hook-event}` in
`src/cli.ts`; three new `HandoffStore` methods in `src/handoff/store.ts`; one
new `WorkspaceLockManager` method in `src/handoff/lock.ts`; this document;
the Phase 3B section appended to `docs/FEASIBILITY.md`.

## Capability matrix

| # | Capability | Status | Evidence |
|---|---|---|---|
| 3B.1 | Desktop session tracking (provider, id, repo/worktree, app, activity, task, ownership, evidence) | **VERIFIED** | §1; `test/desktopRegistry.test.ts` |
| 3B.2 | Sessions never associated by shared repo alone | **VERIFIED** | §1; "two sessions sharing a repoRoot..." test |
| 3B.3 | Seven-state ownership model, separate from Phase 3A's | **VERIFIED** | §2; `test/desktopOwnership.test.ts` (10 cases) |
| 3B.4 | Relay-ownership only under the three allowed conditions | **VERIFIED** | §2; §6's blocked/allowed/force-lock tests |
| 3B.5 | A past authorization/confirmation is never standing permission | **VERIFIED** | §2; "a PAST handoff_requested authorization is never reused..." test |
| 3B.6 | `--force-lock` never applied automatically | **VERIFIED** | By construction — not a parameter of the pure function; only the CLI flag sets it, per-call |
| 3B.7 | Codex Desktop liveness: no new, no undocumented mechanism | **VERIFIED** (by not building one) / **UNSUPPORTED** (true liveness itself, unchanged from Phase 2A) | §3 |
| 3B.8 | Claude Desktop hook event capture mechanism | **VERIFIED** (the parser/CLI command) | §4; `test/hookEvent.test.ts` |
| 3B.9 | Hooks wired into the user's real `~/.claude/settings.json` | **NOT DONE** — requires separate explicit permission, documented but not applied | §4 |
| 3B.10 | Desktop CLI commands | **VERIFIED** | §5 |
| 3B.11 | Desktop-to-CLI continuation reuses `HandoffEngine` unchanged, no new engine | **VERIFIED** (against fakes) | §6; `test/desktopHandoff.test.ts` |
| 3B.12 | Discovery/association/transfer/rejection/recovery against fake Desktop-shaped sessions | **VERIFIED** (against fakes) | §7 |
| 3B.13 | Live discovery against a real Desktop session | **VERIFIED** (read-only; already demonstrated in Phase 2A, not re-attempted here) | §7 |
| 3B.14 | Live end-to-end desktop-to-CLI continuation (real model turn) | **UNVERIFIED** — needs a separate explicit go-ahead, not requested in this phase | §7 |
| 3B.15 | Automatic exhaustion detection reuses existing monitors, never implies inactivity | **VERIFIED** | §8 |
| 3B.16 | Coordinator hardening reviewed against every listed concern | **VERIFIED** (6 of 7 already satisfied by reused code; 1 honestly documented as an unclosed gap) | §9 |
| 3B.17 | All Phase 0–3A functionality preserved | **VERIFIED** | All 101 pre-existing tests pass unmodified — see verification run |

**Per the task's own completion criteria: fully automatic desktop handoff
(discovery → authorization → transfer → continuation → validation, started
from a real Desktop GUI session, with zero manual intervention) is not
claimed as demonstrated end-to-end.** What is demonstrated, live-capable, and
fully tested is every step of that pipeline against fakes, plus the one step
(read-only Desktop-session discovery) that was already safely demonstrated
live in Phase 2A. The specific limitation preventing a full live
demonstration is stated plainly in §7: no tool in this environment can open
or drive a real Codex Desktop or Claude Desktop GUI window, and a live
model-call verification of the continuation step itself needs separate,
explicit authorization that this phase did not request.

## Verification run

```
npm run typecheck   # tsc --noEmit — PASS
npm run lint        # eslint src test — PASS
npm run build       # tsc — PASS
npm run test        # tsc build + node --test — PASS (131/131: 101 pre-existing + 30 new)
```
