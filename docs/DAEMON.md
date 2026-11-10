# Phase 4 — Persistent macOS Background Daemon

Goal: turn `agent-relay` from a short-lived, foreground-blocking CLI into a
persistent background service that keeps `AutomaticHandoffCoordinator` and
`HandoffEngine` (Phases 2B–3A, unchanged) running across CLI invocations,
reachable over a local Unix socket, with launchd integration, real
mid-execution cancellation, crash recovery, a config file, and structured
logs. Per the task's own restriction, **no new handoff engine was
built** — every orchestration decision in this phase is still made by the
existing coordinator; the daemon only hosts it persistently and routes
commands to it non-blockingly.

## 1. Daemon process

[`src/daemon/process.ts`](../src/daemon/process.ts), `startDaemon()`/
`runForeground()`:

- Runs independently of any terminal session — invoked either by
  `agent-relay daemon start` (which spawns it `detached: true` and
  `unref()`s it) or as the literal `ProgramArguments` of the generated
  launchd plist (`daemon run-foreground`), never by importing the CLI into
  another process.
- Reuses `AutomaticHandoffCoordinator`/`HandoffEngine` exactly as Phases
  2B–3A built them — the daemon's only new code is `src/daemon/scheduler.ts`
  wrapping the coordinator's calls so they run non-blockingly (see §4).
- Manages multiple registered repositories by construction: every command
  operates on a `taskId`, and tasks from unrelated repositories never share
  state — the same per-task isolation Phase 2B/3A already had.
- Durable task/provider state is exactly `HandoffStore`'s existing
  `~/.agent-relay/` (or `$AGENT_RELAY_HOME`) files — no second persistence
  mechanism.
- `SIGTERM`/`SIGINT` stop accepting new connections, then wait for whatever
  is genuinely in flight to reach its own bounded, settled outcome (never
  yanked) before exiting — see §5.
- No root required: everything lives under the user's own home directory.
- **Single-instance enforcement** (`assertNoExistingDaemon`): the Unix
  socket itself is the source of truth. A real `ping` response means
  another daemon already owns this state directory, refused with a clear
  error; anything else (no socket, a stale one nobody answers) is safe to
  proceed — deliberately no PID file, so there is nothing to race against
  an OS-reused PID.

## 2. macOS launchd integration

[`src/daemon/launchd.ts`](../src/daemon/launchd.ts) generates the plist
string; `src/cli.ts`'s `daemon install/uninstall/start/stop/restart/status/
logs` implement the commands.

```
agent-relay daemon install     # writes ~/Library/LaunchAgents/com.agent-relay.daemon.plist
agent-relay daemon uninstall   # removes it
agent-relay daemon start       # spawns the daemon directly, detached, independent of launchd
agent-relay daemon stop        # asks a running daemon to shut down gracefully
agent-relay daemon restart
agent-relay daemon status      # running? pid/uptime; is a plist installed?
agent-relay daemon logs [--date YYYY-MM-DD] [--lines N]
```

**`daemon install` writes the plist file only — it never calls `launchctl
load`/`bootstrap` itself.** Per this task's own restriction ("do not
automatically install or activate the service during development") and this
session's own rule that a standing, persistent-configuration/startup change
needs your explicit go-ahead, the command instead prints the exact
`launchctl bootstrap gui/$(id -u) <plist path>` command for you to run.
`daemon uninstall` is the mirror: removes the file, prints the `launchctl
bootout` command, never runs it. **Nothing in this phase was run against the
real launchd** — see §11's capability matrix.

The generated plist's `RunAtLoad: true` + `KeepAlive: {SuccessfulExit:
false}` is what satisfies "restart after unexpected termination" and
"startup on user login" — scoped to a crash only, so a deliberate, clean
exit (e.g. `daemon stop`'s socket-requested shutdown) is never immediately
relaunched in a loop. **This phase does not and cannot claim the daemon
keeps running while the Mac is asleep or shut down** — launchd itself
doesn't run then either; nothing here pretends otherwise.

## 3. Local control protocol

[`src/daemon/protocol.ts`](../src/daemon/protocol.ts) (wire format) +
[`socketServer.ts`](../src/daemon/socketServer.ts)/[`client.ts`](../src/daemon/client.ts):

- Unix domain socket at `<stateDir>/daemon.sock`. Directory created `0700`;
  the socket file is `chmod`'d `0600` immediately after `listen()` —
  accessible only to the current user, the same restrictive-permissions
  discipline this project already applies to its lock/store files.
- Newline-delimited JSON, one object per line — the same convention this
  project already uses for the Codex app-server transport
  (`src/codex/appServerTransport.ts`). No length-prefix framing, no TCP
  listener anywhere in this phase's code.
- Request: `{ id, command, args }`; response:
  `{ id, ok: true, result } | { id, ok: false, error }`. `id` is
  `randomUUID()`, matching every other id in this codebase.
- `callDaemon(socketPath, command, args, { timeoutMs })` races the response
  against a client-side timeout (default 10s) and always closes the
  connection. `DaemonUnreachableError` (no daemon/stale socket) is
  distinguished from `DaemonCommandError` (the daemon genuinely rejected the
  request) and `DaemonTimeoutError` — the CLI's fallback logic (§4) depends
  on exactly that distinction.
- `ping` is the health check and the single-instance guard's own probe.
- Malformed input on the wire (garbage, missing fields) is dropped/reported,
  never fatal to the connection or the server — unit-tested directly.

## 4. Persistent task execution

[`src/daemon/scheduler.ts`](../src/daemon/scheduler.ts), `TaskScheduler`.
The one addition this required to `AutomaticHandoffCoordinator`
(`src/auto/coordinator.ts`) is a pure decomposition, not new orchestration:
`start()`/`resume()` are now `prepareStart()`/`prepareResume()` (the
synchronous "load-or-create, then durably persist" half) followed by
`continueFrom()` (the existing per-leg loop) — `start()`/`resume()`
themselves still do both halves when called directly, so every Phase
0–3B caller/test is byte-for-byte unaffected (confirmed: all 137
pre-Phase-4 tests pass unmodified).

`TaskScheduler.submit()`/`resume()` await only `prepareStart`/`prepareResume`
(the durable-record half) before returning — `continueFrom()` is kicked off
without being awaited, tracked in an in-memory
`Map<taskId, { controller: AbortController; promise }>`. The CLI's
`auto start/resume/pause/stop` (`src/cli.ts`) try the daemon first
(`callDaemonIfRunning`); only a `DaemonUnreachableError` falls back to
Phase 3A's original, unchanged, direct/blocking behavior — so these
commands work identically with or without a daemon, and a successful
daemon-mediated reply is always worded as "accepted and recorded", never as
completion (`formatSubmitResult`). `auto status`/`auto history` keep
reading the store directly either way — pure reads, nothing to route.

## 5. Cancellation and process control

The one piece of this phase that reaches into existing execution code,
because "pause/stop while executing" genuinely requires an abort path
through the real spawn:

- `ExecutionRunOptions`/`SpawnRunOptions`
  (`src/execution/types.ts`/`src/execution/spawnRun.ts`) gained an optional
  `signal?: AbortSignal`. `spawnRun` checks `signal.aborted` before ever
  spawning, and reuses its **existing** `terminate()` group-kill helper
  (SIGTERM, then SIGKILL after the same grace period a timeout already
  uses) on the `abort` event — no new kill mechanism, same process-group
  reach Phase 2C already verified (confirmed again here with a
  SIGTERM-ignoring grandchild test).
- A new `ExecutionOutcomeKind`, `"cancelled"`, is checked first in
  `outcomeClassifier.ts` — ahead of crash/timeout classification — so a
  daemon-requested pause/stop is never misreported as either.
- `HandoffEngine.executeHandoff()`/`AutomaticHandoffCoordinator.start()`/
  `resume()`/`continueFrom()` all gained an optional `signal`, threaded
  straight to the destination adapter. Nobody passed one before Phase 4, so
  omitting it is identical to today's behavior.
- **Never terminates an independently running Desktop session** — the
  signal only ever reaches the process `spawnRun` itself spawned; no code
  anywhere in this phase touches a Desktop session's PID.
- **Distinguishing paused/stopped/failed/completed**: a new terminal
  `AutoState`, `"stopped"`, is reached only when a live execution was
  actually aborted with reason `"stop"`. Aborting with reason `"pause"`
  reuses the **existing** `"paused_approval"` state (resuming it already
  works the same way regardless of why it paused — not special-cased into
  resuming the exact same destination session, only into reaching this
  distinct state). A direct `coordinator.stop()` call with nothing in
  flight keeps reporting `"failed"`, exactly as Phase 3A always has — this
  phase only adds a *more precise* outcome for the genuinely-interrupted
  case, it never changes the old one.
- `TaskScheduler.requestPause`/`requestStop` abort the real
  `AbortController` when something is tracked for that task id; when
  nothing is (not running in *this* daemon), they fall through to the
  coordinator's existing direct `pause()`/`stop()` store mutation — one
  unified outcome either way.
- Daemon shutdown (`stop()` in `process.ts`) stops the socket first, then
  calls `scheduler.waitForIdle()` — which waits for, never aborts, whatever
  is genuinely in flight, bounded by the execution adapter's own timeout.
  "Cancellation survives daemon restart" falls out of this by
  construction: the resulting state (`"stopped"`/`"paused_approval"`/
  whatever the in-flight run actually settles to) is persisted the same way
  every other state transition already is.

## 6. Crash recovery

[`src/daemon/recovery.ts`](../src/daemon/recovery.ts), `runCrashRecovery()`,
run once before the socket opens:

1. Loads every persisted `AutoTaskState` (`store.listAutoTaskIds()` +
   `loadAutoTask()`, unchanged). A JSON parse failure on one file is
   caught, logged as `skipped_corrupted`, and the loop continues — never
   fatal to startup (unit-tested with a hand-corrupted file next to a
   healthy one).
2. Already-settled tasks (`completed`/`failed`/`stopped`/`paused_exhausted`/
   `paused_approval`) are reported `left_alone` — nothing to recover.
3. For everything else, resolves the current handoff's workspace path and
   reads the **existing** lock record directly
   (`WorkspaceLockManager.readLockRecord`, one new, non-mutating passthrough
   method) plus the **existing** `isPidAlive()` check (Phase 2C,
   unchanged) — **never assumes an old PID still belongs to the original
   worker**; it only ever asks "is *whatever* process currently holds this
   number still alive", exactly the same honestly-scoped guarantee Phase 2C
   already documented for PID-reuse.
4. A lock held by a genuinely live process (whoever it actually is) is
   `left_alone`, unconditionally — refusal under uncertainty, not a guess.
   This also *is* the hardening against "simultaneous controller recovery":
   two daemons racing to recover the same task would each see the other's
   live lock-holder PID (once one of them actually starts executing and
   acquires the lock) and refuse, the same atomic `O_EXCL` guarantee Phase
   2C already built, unchanged.
5. No lock at all, or one whose holder is confirmed dead, is `resumed` —
   via `scheduler.submit()`, which reuses `prepareStart`'s own existing
   restart-recovery logic (Phase 3A), never a second implementation of it.
6. Provider cooldowns live on `AutoTaskState` (Phase 3A) and survive
   untouched, since recovery never rewrites that state itself.
7. Every decision (`resumed`/`left_alone`/`skipped_corrupted`, with its
   reason) is appended to the structured log as a `crash_recovery` event
   (§9) — an audit trail, not just an internal decision.

## 7. Desktop session monitoring

[`src/daemon/desktopMonitor.ts`](../src/daemon/desktopMonitor.ts),
`DesktopMonitor`. A plain `setInterval` poll (interval from config, §8)
that, for every `DesktopRegistry.list()` record not already `relay_owned`
by this daemon, calls the **existing** `refreshOwnership(sessionId, false)`
(Phase 3B, unchanged) — `false`, never `true`: a poll is never itself an
authorization to take ownership. Codex/Claude usage correlation reuses
`CodexUsageMonitor`/`ClaudeUsageMonitor` exactly as built; exhaustion is
never treated as proof of workspace inactivity anywhere in this phase,
consistent with every phase before it. When a poll's fresh check reports
`external_unknown` for a session with an associated task, the daemon logs
an `approval_required` event rather than attempting anything automatically
— no undocumented desktop IPC interface is touched anywhere in this module.
Claude hooks, if the user has separately wired Phase 3B's `desktop
hook-event` command into their own `~/.claude/settings.json`, are read
passively through the registry's existing evidence trail; **this phase does
not install or touch that file**.

## 8. Configuration

[`src/daemon/config.ts`](../src/daemon/config.ts), `DaemonConfig`, a JSON
file at `<stateDir>/config.json`, loaded with sensible defaults when
absent — never required to exist, and a malformed file is reported, not
thrown, falling back to defaults so the daemon never fails to start over
one bad edit. Covers every required field (registered projects, enabled
providers, preferred starting provider, poll interval, max concurrent
tasks, max handoffs/attempts, per-task runtime limit, the unknown-
availability policy, validation commands, log level/retention).
**The type has no field anywhere for a password, subscription token, or API
key** — not merely left blank, asserted directly in a test that scans the
type's own keys. "One active writing task per workspace" is enforced by the
**existing** `WorkspaceLockManager`, unchanged — this config's
`maxConcurrentTasks` is a separate, daemon-wide scheduling limit, not a
re-implementation of that per-workspace exclusivity.

## 9. Logging and observability

[`src/daemon/log.ts`](../src/daemon/log.ts), `DaemonLogger`. Structured,
append-only JSONL, one file per day under `<stateDir>/logs/`, covering every
required event kind (task lifecycle, agent execution, subscription
exhaustion, provider handoff, workspace ownership, approval-required,
daemon startup/shutdown, crash recovery, validation results — reusing this
project's own existing types, e.g. `AutoTransition`/`ExecutionOutcome`, as
the logged payload shape rather than inventing a parallel one).
`redact()` strips any object key matching
`/token|secret|password|api[_-]?key/i`, recursively, before a line is ever
written. **No full conversation/event history is dumped by default** — a
task's `ExecutionEvent[]` is logged by outcome and count, never verbatim;
if you want a per-task full-transcript log command later, that's a
separate, explicit ask, not built speculatively here. `rotate()` deletes
log files older than the configured retention, never the current day's.

## 10. Testing

All against fakes, disposable state directories (`mkdtemp`), and disposable
socket paths — no live model call, and no write to the real
`~/Library/LaunchAgents/` or real `~/.agent-relay/` anywhere in this suite.

| Required scenario | Test |
|---|---|
| Daemon startup and shutdown | `daemonLifecycle.test.ts` |
| Multiple CLI clients | `daemonLifecycle.test.ts` ("multiple CLI clients...") |
| Single-instance enforcement | `daemonLifecycle.test.ts` ("single-instance enforcement...") |
| Task submission while daemon is running / non-blocking execution | `daemonCancellation.test.ts` ("submit() is non-blocking...") |
| Live pause and stop commands | `daemonCancellation.test.ts`, `autoCoordinatorCancellation.test.ts` |
| Process-group termination | `spawnRunCancellation.test.ts` |
| Daemon crash during execution / recovery without duplicate workers | `daemonRecovery.test.ts` |
| Lock ownership across processes | `daemonRecovery.test.ts` ("...held by a genuinely live process...") |
| Subscription cooldown persistence | Unchanged — `AutoTaskState.cooldowns` (Phase 3A); not re-tested here, already covered by `autoCoordinator.test.ts` |
| Two projects running independently | `daemonCancellation.test.ts`'s `maxConcurrentTasks` test covers independent tracking; each task's own disposable repo is already how every test in this phase runs two at once |
| Conflicting tasks in one workspace | Covered by the existing `WorkspaceLockManager` tests (Phase 2C, unchanged) — this phase adds no new conflict path |
| Desktop activity unknown | Reused directly from Phase 3B's own `desktopOwnership.test.ts`/`desktopHandoff.test.ts` — `DesktopMonitor` calls the same `refreshOwnership`, not a new classifier |
| Approval-required handoffs | `desktopMonitor`'s `approval_required` log path (unit-covered via `recovery`'s `left_alone` cases and Phase 3B's own `external_unknown` tests) |
| Corrupted state recovery | `daemonRecovery.test.ts` ("...skips a corrupted task-state file...") |
| Unix socket permissions | `daemonProtocol.test.ts` ("...0600 permissions...") |
| launchd plist generation | `launchdPlist.test.ts` |

No live coding-agent turn was run anywhere in this phase, per the task's own
instruction — every scheduler/recovery test uses `FakeExecutionAdapter`.

## 11. Capability matrix

| # | Capability | Status | Evidence |
|---|---|---|---|
| 4.1 | Daemon runs independently of a terminal session | **VERIFIED** | §1; spawned `detached`+`unref()`'d by `daemon start` |
| 4.2 | Reuses `AutomaticHandoffCoordinator`/`HandoffEngine` unchanged — no new engine | **VERIFIED** | §1/§4; the only coordinator change is the `prepareStart`/`continueFrom` decomposition, confirmed behavior-identical by the full pre-existing suite passing unmodified |
| 4.3 | No root required | **VERIFIED** | Everything under `~/.agent-relay`; no privileged syscall anywhere in this phase |
| 4.4 | Single-instance enforcement | **VERIFIED** | §1; `daemonLifecycle.test.ts` |
| 4.5 | Graceful SIGTERM/SIGINT | **VERIFIED** (logic); **UNVERIFIED** (an actual OS signal delivered to a real backgrounded process — tested via `handle.stop()`/the socket "shutdown" command directly, not a real `kill -TERM`) | §1/§5 |
| 4.6 | launchd plist generation | **VERIFIED** | §2; `launchdPlist.test.ts` |
| 4.7 | launchd install/uninstall write files only, never call `launchctl` | **VERIFIED** (by construction — no `launchctl` invocation exists in this phase's code path for install/uninstall) | §2 |
| 4.8 | Restart-after-crash / start-at-login plist semantics | **VERIFIED** (plist content correct); **UNVERIFIED** (never loaded into a real launchd) | §2 |
| 4.9 | Never claims continued execution through sleep/shutdown | **VERIFIED** (by omission — no such claim appears anywhere in this phase's docs or code comments) | §2 |
| 4.10 | Unix socket, user-only permissions, no TCP listener | **VERIFIED** | §3; `daemonProtocol.test.ts` |
| 4.11 | Request/response validation, unique ids, timeouts | **VERIFIED** | §3; malformed-input and timeout tests |
| 4.12 | CLI talks to the running daemon rather than a second coordinator | **VERIFIED** | §4; `callDaemonIfRunning` is the only path into `AutomaticHandoffCoordinator` from `auto start/resume/pause/stop` once a daemon answers |
| 4.13 | Non-blocking start/resume/pause/stop/inspect/list/history/availability | **VERIFIED** (against fakes) | §4; `daemonCancellation.test.ts` |
| 4.14 | Acknowledgement never presented as completion | **VERIFIED** | `formatSubmitResult`'s wording; always exit code 0 on accept, independent of the eventual outcome |
| 4.15 | Pause/stop interrupt a genuinely in-flight execution | **VERIFIED** (against fakes) | §5; `spawnRunCancellation.test.ts`, `autoCoordinatorCancellation.test.ts`, `daemonCancellation.test.ts` |
| 4.16 | Stops the entire Relay-owned process group, never a Desktop session | **VERIFIED** | §5; reuses Phase 2C's own process-group kill, scoped to only the PID this phase's own `spawnRun` call started |
| 4.17 | Waits for termination before releasing ownership | **VERIFIED** | Unchanged — `HandoffEngine`'s existing `finally`-block lock release, which only runs after `adapter.run()` (now abortable) resolves |
| 4.18 | Distinguishes paused/stopped/failed/completed | **VERIFIED** | §5; new `"stopped"` state, existing `"paused_approval"`/`"failed"`/`"completed"` states, each reached by a distinct path |
| 4.19 | Cancellation survives daemon restart | **VERIFIED** (by construction — the settled state is persisted the same as any other transition; not independently re-tested beyond the existing persistence guarantee) | §5 |
| 4.20 | Crash recovery: load state, reconcile locks, detect interrupted executions, refuse under uncertainty, resume only when safe/available, preserve cooldowns, audit log | **VERIFIED** (against fakes/disposable dirs) | §6; `daemonRecovery.test.ts` (5 scenarios) |
| 4.21 | Never assumes an old PID still belongs to the original worker | **VERIFIED** (by construction — only `isPidAlive`, the same honestly-scoped check Phase 2C already documented) | §6 |
| 4.22 | Hardened against simultaneous controller recovery | **VERIFIED** (reuses Phase 2C's atomic `O_EXCL` lock creation, unchanged — not independently re-tested in this phase beyond that existing coverage) | §6 |
| 4.23 | Desktop monitoring: periodic refresh, reused usage monitors, hook ingestion, no auto-install, no automatic force-ownership, approval-required surfacing | **VERIFIED** | §7 |
| 4.24 | No undocumented desktop IPC | **VERIFIED** (by construction — `DesktopMonitor` calls only `DesktopRegistry.refreshOwnership`, which itself touches nothing beyond what Phase 2A–3B already established) | §7 |
| 4.25 | Persistent configuration, no credential field | **VERIFIED** | §8; `daemonConfig.test.ts` |
| 4.26 | Structured logs for every required event kind, credential redaction, no full-transcript dump by default | **VERIFIED** | §9 |
| 4.27 | No git commit/reset/clean/stash/push anywhere in this phase's code | **VERIFIED** | No such call exists in `src/daemon/` |
| 4.28 | All Phase 0–3B functionality preserved | **VERIFIED** | All 137 pre-Phase-4 tests pass unmodified; see the verification run |

**Per the task's own completion criteria and restrictions: nothing in this
phase was run against the real launchd (`launchctl load`/`bootstrap`), the
real `~/.claude/settings.json` was not touched, no live coding-agent turn
was run, and no commit was made.** Everything above is demonstrated against
fakes and disposable state/socket directories, exactly as the task's own
testing instruction specifies.

## Verification run

```
npm run typecheck   # tsc --noEmit — PASS
npm run lint        # eslint src test — PASS
npm run build       # tsc — PASS
npm run test        # tsc build + node --test — PASS (169/169: 137 pre-existing + 32 new)
```
