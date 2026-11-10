# Phase 2B/2C — Cross-Provider Handoff Engine

**Phase 2C update:** the workspace-ownership logic described in §3 was
hardened, and both handoff directions were verified with real,
subscription-authenticated CLI calls in disposable repositories — see
[Phase 2C — Live Verification](#phase-2c--live-verification) at the end
of this document for what changed and what the live run actually did.

## Phase 2B — Cross-Provider Handoff Engine

Goal: move an unfinished coding task between Codex CLI and Claude Code
CLI, in either direction, through a structured, durable handoff package —
not by pretending one provider can resume the other's native session.
This phase builds the full engine (persistence, locking, real execution
adapters, usage gating) and tests it completely against **fake** agents
and disposable repositories. **No live cross-provider execution has been
run in this phase** — see "Live verification" at the end for exactly why,
and what's needed to change that.

## 1. Cross-provider handoff — never a direct resume

`claude` cannot resume a Codex thread, and `codex` cannot resume a Claude
session — there is no shared session format. Instead, `HandoffEngine`
always starts a **new** destination-provider session and feeds it a
structured instruction built entirely from the handoff package's own
fields ([`src/handoff/instruction.ts`](../src/handoff/instruction.ts)):
objective, branch/commit, the modified/untracked file list, whatever
progress the source provider reported, and any explicitly-supplied
remaining steps or known errors. Both directions use the exact same
engine code path — `codex → claude` and `claude → codex` differ only in
which `AgentExecutionAdapter` is selected for `to`.

CLI-originated and Desktop-originated sessions are handled identically
once discovered (Phase 2A already proved both are discoverable through
the same interfaces). What's *not* attempted here, for the same safety
reasons Phase 2A gave: handing off a session that's still a live
Desktop tab. A handoff can be *prepared* from any discovered session,
but `execute()`'s workspace lock (§3) will refuse to start if an active
session is still reported against that workspace.

## 2. The handoff package

[`src/handoff/types.ts`](../src/handoff/types.ts), `HandoffRecord` —
every field the task listed is there. The type-level discipline that
backs "never invent missing task descriptions, progress, or remaining
work": `originalTaskObjective`, `availableImplementationProgress`,
`knownErrors`, and `remainingImplementationSteps` are all `null`/`[]`
unless something real populated them — the source provider's own
recorded title/status (reusing Phase 2A's `prepareHandoffSnapshot`
verbatim, not a reimplementation), or an explicit value a human supplied.
`HandoffEngine.executeHandoff()` enforces the objective rule in code, not
just by convention: if `originalTaskObjective` is `null` and no
`suppliedObjective` is given, it throws before touching anything —
tested in `test/handoffEngine.test.ts`.

Uncommitted changes are preserved by omission: nowhere in this phase's
code is there a call to `git commit`, `reset`, `clean`, or `stash`.
`prepareHandoffSnapshot` (Phase 2A) only ever runs `status`, `branch
--show-current`, and `rev-parse HEAD`; `HandoffEngine` runs no `git`
commands of its own at all. A dedicated test
(`test/workspaceLockAndFiles.test.ts`, "preserves modified/untracked
files exactly") creates a dirty disposable repo, runs a full handoff
through it, and asserts `git status --porcelain=v1` is byte-for-byte
identical before and after.

## 3. Workspace ownership and concurrency

[`src/handoff/lock.ts`](../src/handoff/lock.ts), `WorkspaceLockManager`.
Per the task's five steps:

1. **Workspace accessible** — reuses Phase 2A's `isWorkspaceAccessible`.
2. **Relay-managed worker active** — a lock record
   (`{ workspacePath, holderPid, holderHandoffId, acquiredAt }`) is read;
   `holderPid` liveness is checked with `process.kill(pid, 0)` (the
   standard zero-signal probe: `ESRCH` means gone, `EPERM` means alive
   under another user, no error means alive and ours).
3. **Provider activity signals** — an injected
   `checkProviderActivity(workspacePath, excludeSessionId)` callback; the
   real default re-runs Phase 2A's `discoverAllSessions()` against that
   path and treats Claude's `"busy"` or Codex's `"active"` status
   (excluding the handoff's own source session) as a busy signal.
4. **Refuse automatic takeover** — any live signal from steps 2 or 3
   refuses the lock outright.
5. **Transfer only when safe or confirmed** — `forceLockOverride: true`
   (the CLI's `--force-lock`) is the only way past a live signal; it's
   recorded on the attempt (`lockOverrideUsed: true`) so it's auditable
   later, never silent.

**"Do not consider an expired lock sufficient proof that an old writer
has stopped"** is enforced directly: there is no age/TTL check anywhere
in `acquire()`. The only thing that clears a lock without an explicit
override is the recorded PID genuinely no longer running — tested with a
real dead PID (a spawned, already-exited process) versus this process's
own live PID holding a *different* handoff's lock on the same path.

## 4. CLI execution adapters

[`src/execution/spawnRun.ts`](../src/execution/spawnRun.ts) is the one
shared primitive both real adapters use: `child_process.spawn` with an
explicit argument array (never a shell string — no injection surface),
an explicit `cwd`, an environment built as `{ ...process.env, ...extra }`
rather than passed through blind, a hard output cap (10 MiB default,
configurable; the process is killed the moment it's exceeded), an
execution timeout (10 minutes default, configurable), and SIGTERM then,
after a 5s grace period, SIGKILL.

- [`CodexExecutionAdapter`](../src/execution/codexExecutionAdapter.ts):
  `codex exec --json --sandbox workspace-write --skip-git-repo-check
  [resume <id>] "<instruction>"`.
- [`ClaudeExecutionAdapter`](../src/execution/claudeExecutionAdapter.ts):
  `claude -p --output-format stream-json --verbose --permission-mode
  acceptEdits [--resume <id>] "<instruction>"`.

Neither ever passes `--dangerously-bypass-approvals-and-sandbox` or
`--dangerously-skip-permissions`/`bypassPermissions`. `workspace-write`
and `acceptEdits` are the same restricted-but-functional modes verified
live in Phase 2A §4 — enough to let a non-interactive turn actually edit
files, not enough to grant unrestricted execution.

### Classifying why a run ended

[`src/execution/outcomeClassifier.ts`](../src/execution/outcomeClassifier.ts)
distinguishes `rate_limited` / `auth_failed` / `context_exhausted` /
`permission_required` / `crashed` / `timed_out` / `invalid_output` /
`completed`. Honesty note, consistent with every prior phase's own
findings: **Codex's classification is free-text matching**, because
`codex exec --json` carries no structured field for any of these (same
limitation Phase 0 found for plain rate-limit classification). **Claude's
rate-limit classification is structured** — it reuses
`classifyClaudeLine` from Phase 1B directly, so a real `rate_limit_event`
also yields a real `cooldownResetsAt`. Claude's other categories
(auth/context/permission) are still text-matched, because — also
consistent with Phase 2A's own live observation ("I need permission to
write the file...") — Claude surfaces these as ordinary assistant text,
not a distinct structured event type.

## 5. Cross-provider continuation (the ten steps)

`HandoffEngine.executeHandoff(handoffId, { to, ... })` in
[`src/handoff/engine.ts`](../src/handoff/engine.ts), in order:

1. Load the handoff record (throws if the id doesn't exist — a caller
   error, not a runtime outcome).
2. Resolve the objective (`originalTaskObjective` or `suppliedObjective`;
   throws if neither exists).
3. Check destination usage availability (§6) — blocks before step 4 if
   exhausted.
4. Acquire the workspace lock (§3) — blocks before step 5 if refused.
5. Decide fresh-start vs. resume: if the *previous* attempt on this same
   handoff left it `interrupted` (or stuck `executing` from an engine
   crash) and recorded a destination session id for the *same*
   destination provider, this run resumes that session with a short
   nudge instead of the full instruction; otherwise it's a fresh start
   with the full package.
6. Start the destination adapter.
7. Capture its structured events (bounded — see §4's output cap).
8. Record the destination session id on the attempt, whatever happened.
9. Run any explicitly-configured validation commands (only if the
   provider outcome was `completed`; stops at the first failure).
10. Final status: `completed` only if the provider finished *and* every
    configured validation command passed; `failed_validation` if the
    provider finished but validation didn't; `interrupted` for every
    other non-blocked outcome (crash, timeout, rate limit, auth failure,
    context exhaustion, permission-required, or unparseable output) —
    all of them resumable by calling `executeHandoff` again.

The lock is always released in a `finally` block, including every one of
those non-`completed` paths — a crash in the destination *process* still
lets go of the workspace; only a crash of *this engine's own process*
leaves a stale lock behind, and that's exactly what §3's PID-liveness
recovery is for.

## 6. Usage-limit integration

[`src/handoff/usageDecision.ts`](../src/handoff/usageDecision.ts),
`evaluateProviderAvailability()` — reuses `CodexUsageMonitor` (Phase 1A)
and `ClaudeUsageMonitor` (Phase 1B) exactly as they are, unmodified:

- `exhausted` → `block`. `executeHandoff` never calls the destination
  adapter in this case — tested directly.
- `available` → `start`.
- `unknown` → `proceed_with_caution` — a *distinct* decision, not
  silently treated as `available`. Per the task's instruction not to
  build automatic switching yet, this phase's one caller (an explicit,
  human-invoked `handoff execute`) treats `proceed_with_caution` the same
  as `start` — an explicit human request is not the "automatic" case the
  task is warning about. **Phase 3's automatic logic can choose
  differently**: `evaluateProviderAvailability()` hands it the
  distinction already made, rather than collapsing it here.
- Cooldown: recorded on the *outcome* classification (§4) when the
  destination run itself hits a rate limit, and separately available on
  whatever `UsageSnapshot` the pre-execution check returned
  (`primary.resetsAt`) — both paths, not just one.
- **No model request is ever generated solely to check Claude's usage.**
  `ClaudeUsageMonitor` (Phase 1B) is passive by construction; this engine
  constructs one fresh per call and never feeds it anything, so it
  honestly reports `unknown` unless something else in the system has
  separately observed a real session's `rate_limit_event` — exactly the
  Phase 1B contract, unchanged.

## 7. CLI commands

```
agent-relay handoff prepare <session-id> [--reason "..."]
agent-relay handoff execute <handoff-id> --to <claude|codex> [--objective "..."] [--force-lock] [--validate "cmd"]... [--timeout-ms N]
agent-relay handoff status <handoff-id>
agent-relay tasks
agent-relay task inspect <task-id>
```

`handoff prepare` is still read-only toward the *discovered session's
repository* — it runs the same three `git` reads Phase 2A always did and
never spawns an agent or takes a lock. It now also persists the result
as a durable, ID-addressable `HandoffRecord`/`Task` under
`~/.agent-relay/` (overridable via `AGENT_RELAY_HOME`, which every test
in this phase uses to point at a disposable directory instead) — writing
this tool's own bookkeeping file is not a modification of the user's
project, and it's what gives `handoff execute`/`status` something to act
on.

## 8. Live verification — UNVERIFIED by design

**No real cross-provider execution was run in this phase.** Every one of
the required test scenarios — both handoff directions, partial-progress
preservation, concurrent/stale locks, exhausted/unknown usage, crashes,
invalid output, permission-required events, validation failure, and
interrupted-handoff recovery — is verified against `FakeExecutionAdapter`
(see `test/helpers/fakeExecutionAdapter.ts`) and disposable git repos,
exactly as the task's completion criteria call for.

The real adapters (§4) are genuine, runnable code — not stubs — and
`handoff prepare`/`status`/`tasks`/`task inspect` were smoke-tested live
against this machine's real discovered sessions (read-only; no agent was
spawned). `handoff execute` itself was deliberately **not** run against
the real `codex`/`claude` binaries this phase, since doing so spends real
subscription usage and the task's own completion criteria say to report
it UNVERIFIED until a live test is separately authorized — the same
approval gate Phase 2A's disposable continuation test went through. If
you want that run, the shape would mirror Phase 2A §4: a disposable repo,
one bounded `handoff execute ... --to <provider>` call, and a report of
whatever `handoff status` shows afterward.

## 9. Testing

| Required scenario | Test |
|---|---|
| Codex-to-Claude handoff | `handoffEngine.test.ts` |
| Claude-to-Codex handoff | `handoffEngine.test.ts` |
| Partial implementation preservation | `handoffEngine.test.ts` ("partial implementation preservation") |
| Modified and untracked files | `workspaceLockAndFiles.test.ts` ("preserves modified/untracked files exactly") |
| Multiple worktrees | `workspaceLockAndFiles.test.ts` ("multiple worktrees...") |
| Missing task objectives | `handoffEngine.test.ts` ("missing task objective") |
| Missing repository directories | `handoffEngine.test.ts` ("missing repository directory") |
| Concurrent workspace ownership | `workspaceLockAndFiles.test.ts` ("concurrent workspace ownership") |
| Stale locks and live processes | `workspaceLockAndFiles.test.ts` ("stale lock...", and the live-lock half of "concurrent workspace ownership") |
| Exhausted destination providers | `handoffEngine.test.ts` ("exhausted destination provider") |
| Unknown usage status | `handoffEngine.test.ts` ("unknown destination usage status") |
| Agent crashes | `handoffEngine.test.ts` ("agent crash") |
| Invalid execution output | `handoffEngine.test.ts` ("invalid/unparseable execution output") |
| Permission-required events | `handoffEngine.test.ts` ("permission-required event") |
| Validation failure | `handoffEngine.test.ts` ("validation failure" / "validation success") |
| Interrupted handoff recovery | `handoffEngine.test.ts` ("interrupted handoff recovery") |

All of it runs against fake agents and disposable repos/stores — no
cross-provider execution test spends real usage.

## 10. Capability matrix

| # | Capability | Status | Evidence |
|---|---|---|---|
| 2B.1 | Bidirectional handoff orchestration (both directions, same engine code path) | **VERIFIED** (against fakes) | §9 |
| 2B.2 | Structured, provider-independent handoff package, never fabricated | **VERIFIED** | Type-level (`HandoffRecord`) + the missing-objective refusal test |
| 2B.3 | Uncommitted changes preserved (no commit/reset/clean/stash) | **VERIFIED** | No such `git` call exists in this phase's code; byte-identical `git status` test |
| 2B.4 | Exclusive workspace locks with crash recovery | **VERIFIED** | Live-PID-refused vs. dead-PID-recovered tests |
| 2B.5 | Expired lock age alone is never sufficient to reclaim | **VERIFIED** | By construction — no TTL/age check in `acquire()` |
| 2B.6 | Real Codex/Claude execution adapters (safe spawn, no bypass modes) | **VERIFIED** (code and, as of Phase 2C, live) | §4, [Phase 2C §live](#phase-2c--live-verification) |
| 2B.7 | Structured event capture, bounded output, timeout + kill escalation | **VERIFIED** (logic paths unit-tested; process-group kill-escalation now also verified against a real misbehaving descendant in Phase 2C) | `spawnRun.ts`, Phase 2C §1 |
| 2B.8 | Outcome classification distinguishes rate limit / auth / context / permission / crash | **VERIFIED** (against fakes); Codex's is free-text matching, Claude's rate-limit path is structured | §4 |
| 2B.9 | Usage-gating decision logic (never start exhausted; unknown ≠ available) | **VERIFIED** | `usageDecision.ts` + blocking/caution tests |
| 2B.10 | No model request generated solely to check Claude usage | **VERIFIED** | By construction — `ClaudeUsageMonitor` is never fed anything by this engine |
| 2B.11 | Durable task/handoff persistence, crash-safe writes | **VERIFIED** | Atomic write-temp-then-rename in `store.ts`; exercised by every engine test plus a live CLI smoke test against a real discovered session |
| 2B.12 | CLI commands (`handoff execute/status`, `tasks`, `task inspect`) | **VERIFIED** (commands work; live `execute` verified in Phase 2C, driven directly rather than through the CLI binary — see below) | §7, Phase 2C §live |
| 2B.13 | `handoff prepare` remains read-only toward the source repository | **VERIFIED** | Same three `git` reads as Phase 2A; no new repo-mutating call added |
| 2B.14 | Interrupted handoffs are resumable, not restarted from scratch | **VERIFIED** (against fakes) | "interrupted handoff recovery" test |

---

## Phase 2C — Live Cross-Provider Handoff Verification

### 1. Safety corrections

Six concrete hardening changes to [`src/handoff/lock.ts`](../src/handoff/lock.ts),
[`src/handoff/engine.ts`](../src/handoff/engine.ts), and
[`src/execution/spawnRun.ts`](../src/execution/spawnRun.ts):

1. **The source session is no longer excluded from activity checks.**
   Phase 2B's default activity check filtered out the handoff's own
   `sourceSessionId` before looking for a busy session at that
   workspace — meaning a source session that was *still running* would
   never be caught. That exclusion is gone; `defaultCheckProviderActivity`
   now scans every session Phase 2A can discover at that path, source
   included. The "a source session must be confirmed stopped or safely
   idle" requirement falls out of this directly, rather than needing a
   second, separate check: the source session lives at the same
   workspace path as the one about to be locked, so one scan catches
   both.
2. **"Unknown" is no longer treated as safe.** `ProviderActivitySignal`
   is now a tri-state (`confirmed_busy` / `confirmed_idle` / `unknown`),
   and `WorkspaceLockManager.acquire()` refuses on anything other than
   `confirmed_idle` unless `forceOverride` is set. The pure
   classification policy — exported as
   `classifyWorkspaceActivity()` in `engine.ts` for direct unit testing
   — encodes exactly why this matters per provider:
   - **Claude**: `claude agents --json` only lists processes that are
     actually running (Phase 2A §1), so no Claude session found at all
     is a genuine, positive `confirmed_idle`.
   - **Codex**: `thread/list`'s `status` field cannot confirm liveness
     from this process (Phase 2A/`docs/SESSION_DISCOVERY.md` §1). Only
     `status: "active"` is a real signal, and it's a busy one. Any other
     Codex presence at that workspace — including the ordinary,
     overwhelmingly common case of a long-finished thread that simply
     still exists in history — is `unknown`, never `confirmed_idle`.
     **Consequence, stated plainly: a workspace with any Codex history
     at all requires `--force-lock` for an automatic takeover, every
     time**, because this adapter has no documented way to prove that
     thread has truly stopped. That's the intended, conservative
     outcome of this requirement, not a bug to work around.
3. **`--force-lock` stays an explicit, user-initiated escape hatch.**
   It's the *only* thing that gets past a `confirmed_busy` or `unknown`
   signal, or a live-PID lock conflict — there is no automatic path that
   sets it, and nothing in this phase changes that.
4. **Lock age was never load-bearing (Phase 2B), and still isn't** — no
   TTL/expiry check exists anywhere in `acquire()`. The live run below
   (§live) hit the `"unknown"` Codex case exactly zero times only
   because the disposable repos genuinely had no Codex history at all —
   had they, `--force-lock` would have been required, not an aged-out
   lock being assumed safe.
5. **Path aliases and worktrees resolve to the same physical lock.**
   `lockKeyFor()` now resolves the workspace path through `realpath`
   before hashing (falling back to the raw path only if that fails), so
   a symlinked alias and its real target collide on the same lock key —
   tested directly by locking through both and confirming the second
   attempt is refused as already held.
6. **Atomic acquisition for a never-before-held workspace.**
   `HandoffStore.createLockExclusive()` uses `O_EXCL` (`flag: "wx"`) to
   create the lock file — the filesystem itself guarantees at most one
   of two simultaneous callers can win that create. The previous
   read-then-decide-then-write sequence had a TOCTOU race between two
   fresh acquires; this removes it for the case that actually matters
   (nobody holds the lock yet). Reclaiming an existing lock (dead PID,
   or an explicit override) still goes through a plain overwrite —
   an inherent limit of file-based locking without a true OS-level
   advisory lock, called out rather than glossed over.
7. **Timed-out children are killed as a process group.**
   `spawnRun` now spawns with `detached: true` and kills via
   `process.kill(-pid, signal)` on escalation (SIGTERM, then SIGKILL
   after a grace period), reaching every descendant in that POSIX
   process group, not just the one direct child — verified with a test
   that spawns a grandchild that explicitly ignores SIGTERM and confirms
   it's dead after the group kill escalates.
8. **Ownership verification evidence is recorded on every attempt**,
   including blocked ones: `ExecutionAttempt.ownershipVerification`
   (`activityStatus`, `activityReason`, `lockRecoveredFromCrash`,
   `lockOverrideUsed`) — visible in `handoff status` output (see the
   live transcripts below) and in `handoffEngine.test.ts`'s and
   `lockHardening.test.ts`'s assertions.

**A known, honestly-stated limitation: PID reuse.** A crashed holder's
PID can, in principle, be reassigned by the OS to an unrelated process
before this tool checks it, making a genuinely-abandoned lock look live.
`isPidAlive()`'s own doc comment states the property this tool actually
guarantees: it never treats a live PID as safe to steal, whoever it
really belongs to — the failure mode this leaves is *overly cautious*
(occasionally refusing a takeover that was, in fact, safe), never
*unsafe* (never stealing from a real, live writer). A random
`holderToken` is recorded on every lock as audit evidence, but full
cross-platform reuse detection (e.g. comparing process start times) isn't
implemented — macOS has no cheap, portable way to read that without
extra dependencies, and the conservative default already closes the
unsafe direction. `lockHardening.test.ts` tests exactly this: a lock
whose recorded PID now belongs to a real, different, live process is
still refused.

No existing user desktop session was terminated anywhere in this
phase — the only processes this phase's tests or live run ever killed
were ones spawned by this phase's own disposable test fixtures.

### 2–3. Live Codex→Claude and Claude→Codex handoffs {#phase-2c--live-verification}

**Authorization.** Per the task's own instruction, every non-model step
(repository scaffolding, baseline-failure confirmation, handoff-package
preparation) was completed first, with zero live calls. The two bounded
live executions were then explicitly authorized by the user before
either ran.

**Setup**, in a scratch directory outside any real project, deleted
afterward:

- **Repo A** (source: Codex → destination: Claude): a tiny TypeScript
  package with `capitalize()` fully implemented and tested, and
  `reverseWords()` stubbed to `throw new Error("not implemented")`. An
  untracked `NOTES.md` left uncommitted on purpose, to exercise
  untracked-file preservation through a real run. Objective: *"Implement
  `reverseWords`... Do not modify `capitalize`, which is already correct
  and tested."* Validation command: `node --test` (Node's native
  TypeScript support — no build step). Confirmed failing before the
  handoff (the stub throws), proving the baseline was genuinely
  unfinished, not trivially already-passing.
- **Repo B** (source: Claude → destination: Codex): the mirror case —
  `sum()` done, `unique()` stubbed, same untracked-notes setup, same
  "confirmed failing first" check.
- A `HandoffRecord` was prepared for each via `createHandoffRecord()`
  directly (no real Codex/Claude session was discoverable for a repo
  neither had ever touched, so the source session metadata was supplied
  directly, exactly as `handoff prepare` would persist it from a real
  discovered session) — `pending` status, correct `files`/`branch`/
  `commitSha`/`originalTaskObjective`, zero live calls.

**Execution** (`HandoffEngine.executeHandoff`, called directly rather
than through the CLI process — same engine code the CLI command invokes,
with `validationCommands: ["node --test"]`):

| | Repo A: codex → claude | Repo B: claude → codex |
|---|---|---|
| Ownership check | `confirmed_idle` — "no running session found for this workspace" | `confirmed_idle` — same reason |
| `--force-lock` needed? | No — this repo had no Codex thread history at all, so the "Codex presence ⇒ unknown" rule (§1.2) never triggered | No, for the same reason |
| Destination session id | a real Claude session id | a real Codex thread id |
| Outcome | `completed` | `completed` |
| Validation (`node --test`) | **pass** | **pass** |
| Final status | `completed` | `completed` |

**What the destinations actually did** (verified by reading the
repository afterward, not just trusting the reported outcome):

- Claude wrote `reverseWords(input) { return input.split(" ").reverse().join(" "); }` — correct, and left `capitalize` byte-for-byte unchanged.
- Codex wrote `unique(nums) { return [...new Set(nums)]; }` — correct (preserves first-occurrence order, as `Set` does), and left `sum` byte-for-byte unchanged.
- Neither repo gained a new git commit — `git log` still showed only the
  original "Initial partial implementation" commit in both. Neither
  destination agent committed on its own, and this engine never does.
- The untracked `NOTES.md` was still present and untouched in both
  repos afterward.
- Re-running `node --test` independently (outside the engine, as a
  separate sanity check) passed in both repos.
- `handoff status <id>` for both showed `status: completed`, the correct
  destination session id, `validation: node --test=pass`, and the
  ownership-verification evidence (`confirmed_idle — no running session
  found for this workspace`) — exactly what `OwnershipVerification` (§1.8)
  exists to make auditable.

**Result: both directions VERIFIED, live, for real**, meeting every item
in the task's completion criteria: both succeeded in disposable repos,
existing code stayed intact, the destination continued rather than
restarted, the configured validation command passed, no concurrent
workspace writes occurred (each run held its own exclusive lock, released
on completion), and the persisted history records accurate outcomes and
real session references.

### 6. Testing

New test files added for this phase's required scenarios:

| Required scenario | Test |
|---|---|
| Source desktop session still active | `activityClassification.test.ts` |
| Unknown Codex Desktop liveness | `activityClassification.test.ts` |
| Two controllers acquiring the same lock simultaneously | `lockHardening.test.ts` ("two controllers racing...") |
| PID reuse and unexpected process termination | `lockHardening.test.ts` ("a lock whose recorded pid now belongs to a different, unrelated LIVE process...") |
| Symlink workspace aliases | `lockHardening.test.ts` ("symlink workspace alias...") |
| Parent/child process termination | `spawnProcessGroup.test.ts` |
| Lock recovery after controller crash | `lockHardening.test.ts` ("dead pid is still correctly recovered...") |
| Real adapter output parsing using recorded fixtures | `outcomeClassifierFixtures.test.ts` — and it caught a real bug: the first version of `interpretClaudeRun` matched its rate-limit regex against the *entire* raw event dump, which includes the literal field name `rate_limit_event`/`rate_limit_info`, so every Claude run was misclassified as rate-limited. Fixed to match only the assistant-facing `result` text; this is exactly the kind of mistake a fixture-based test catches that a hand-rolled fake wouldn't. |
| Source files preserved through handoff | `sourcePreservationAndPartialFailure.test.ts` |
| Destination failure after partial code modifications | `sourcePreservationAndPartialFailure.test.ts` |
| Validation failure after a successful agent turn | Already covered in Phase 2B's `handoffEngine.test.ts` ("validation failure") |

All of Phase 0 through 2B's existing tests pass unmodified, plus these
additions: **85/85 tests pass** (typecheck, lint, and build also clean).

### Capability matrix (Phase 2C)

| # | Capability | Status | Evidence |
|---|---|---|---|
| 2C.1 | Source session activity is checked, not excluded | **VERIFIED** | §1.1; unit-tested in `activityClassification.test.ts` |
| 2C.2 | Unknown Codex liveness blocks automatic takeover | **VERIFIED** | §1.2; this is also why the live run above never needed `--force-lock` — these disposable repos had no Codex history to be "unknown" about |
| 2C.3 | `--force-lock` remains an explicit-only override | **VERIFIED** | By construction — no code path sets it automatically |
| 2C.4 | Lock age never substitutes for proof of a stopped writer | **VERIFIED** | Still no TTL check anywhere; `lockHardening.test.ts` |
| 2C.5 | Path aliases/worktrees map to the correct physical lock | **VERIFIED** | `realpath`-based `lockKeyFor`; symlink test |
| 2C.6 | Atomic lock acquisition prevents simultaneous double-acquire | **VERIFIED** | `O_EXCL` create; concurrent-race test |
| 2C.7 | Timed-out child *and descendants* are stopped before lock release | **VERIFIED** | Process-group kill; SIGTERM-ignoring-grandchild test |
| 2C.8 | Ownership verification evidence recorded in handoff history | **VERIFIED** | Visible in the live `handoff status` output above |
| 2C.9 | Live Codex → Claude handoff: continues (not restarts), preserves existing code, passes validation | **VERIFIED** (live) | §live |
| 2C.10 | Live Claude → Codex handoff: same | **VERIFIED** (live) | §live |
| 2C.11 | No concurrent workspace writes during either live run | **VERIFIED** | Each run held its own exclusive lock for its own, distinct disposable workspace |
| 2C.12 | PID-reuse safety (never assume a live PID is safe to steal) | **VERIFIED** (the safety property); reuse *detection* itself is an acknowledged, documented limitation | §1 "known limitation" |
| 2C.13 | No existing user desktop session touched or terminated | **VERIFIED** | Only this phase's own disposable-fixture processes were ever killed |
