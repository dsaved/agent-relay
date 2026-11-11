# Phase 9 — Provider-Choice Notifications for Automatic Handoff

Phases 1-8 built two pieces that worked, but separately: automatic handoff
(Phase 3A/4), which silently picked the next enabled provider by priority
order whenever the current one ran out, and live app handoff (Phase 8),
which opens a real, visible session in a chosen destination. This phase
connects them around a real request: when the provider doing the work
runs out, pause, ask which app/CLI to continue on via a real OS
notification, and once picked, seed a real session — leaving opening it
to a separate, manual `handoff open` call.

## What changed

`agent-relay auto start`/the background daemon no longer auto-selects a
destination provider. **This is a deliberate, breaking change** to the
flagship automatic-handoff feature's default behavior, not an additive
flag — see `docs/AUTOMATIC_HANDOFF.md`'s own amendment note.

- `selectAndAdvance()` (`src/auto/coordinator.ts`) now always pauses
  (`paused_approval`) and records every enabled alternative on a new
  `AutoTaskState.pendingProviderChoice` field — unless a `pinnedProvider`
  is already set, in which case it behaves exactly as before Phase 9
  (this is how `auto start --pin <provider>` keeps working unchanged: a
  standing pin never pauses to ask).
- `agent-relay auto resume <task-id> --pin <provider>` supplies the
  choice. It's **consumed after exactly one selection** — cleared back to
  null the moment it's used — so the *next* time the task needs to pick a
  destination, it pauses and asks again, rather than getting stuck pinned
  to whatever just failed. (`pinnedProviderSticky` on `AutoTaskState`
  distinguishes this one-time pin from a standing `auto start --pin`,
  which is never cleared.)

## The notification

Inside the persistent background daemon only (not the foreground `auto
start`/`auto resume` CLI path, which already prints the pending choice to
the terminal you're watching) — `src/daemon/scheduler.ts`'s
`TaskScheduler` fires a real, actionable macOS notification the moment a
task settles into this pause, offering every candidate as a clickable
action. Picking one resumes the task itself, no extra CLI round trip
needed; once that leg actually runs, a second, plain notification says
it's ready to view (`handoff open <handoff-id> --to <provider>` printed
directly — opening it stays a separate, manual step, by design).

### `terminal-notifier` — a new external dependency, not an npm package

macOS's built-in `osascript -e 'display notification'` cannot show custom
action buttons at all — there is no way to build a real "pick one" prompt
on top of it. [`terminal-notifier`](https://github.com/julienXX/terminal-notifier)
is a separately-installed macOS CLI that can:

```bash
brew install terminal-notifier
```

`src/notify/terminalNotifier.ts` detects it the same honest way `claude`/
`codex`/`copilot` already are — absence is reported, never fatal. Without
it, a task still pauses and records `pendingProviderChoice` correctly;
you just won't get a popup, and need to run `auto resume --pin <provider>`
yourself once you notice the pause (`auto status <task-id>` shows it).

**Not installed on the machine this phase was built on — the exact
`-json` response shape (`activationType`/`activationValue`) is
UNVERIFIED** until it's installed and tested live, same gate as every
other live call in this project's history.

## Code map

- `src/auto/types.ts` — `AutoTaskState.pendingProviderChoice`,
  `pinnedProviderSticky`.
- `src/auto/coordinator.ts` — `selectAndAdvance()`'s new pause-first
  branch; `resume()`/`prepareResume()` gain an optional `pin` parameter.
- `src/notify/terminalNotifier.ts` — `checkTerminalNotifierAvailable()`,
  `notifyProviderChoice()`, `notifyReadyToOpen()`.
- `src/daemon/scheduler.ts` — `TaskScheduler.handleSettled()`, the one
  place this phase wires notifications in; fire-and-forget, detached from
  the `inFlight` bookkeeping so a slow or failing notification call never
  delays `requestStop()`/`requestPause()` or affects the coordinator's own
  result.
- `src/cli.ts` — `auto resume <task-id> --pin <provider>`.

## Tests

All against fakes/injected functions — `terminal-notifier` is never
spawned for real in the test suite:

- `test/providerChoicePause.test.ts` — 3+ enabled providers offer every
  alternative; a standing `auto start --pin` never pauses; a one-time
  resume pin is consumed after one selection.
- `test/terminalNotifier.test.ts` — argv/parsing assertions via an
  injectable spawn function; not installed -> honest `null`/no-op.
- `test/schedulerNotifications.test.ts` — the scheduler fires
  `notifyChoice` exactly on a fresh pause, auto-resumes on a pick, fires
  `notifyReady` once a pinned leg actually runs, and a throwing
  notification function never blocks `inFlight` cleanup.
- `test/autoCoordinator.test.ts`, `test/autoCoordinatorCancellation.test.ts`,
  `test/daemonCancellation.test.ts`, `test/daemonRecovery.test.ts`,
  `test/integrationLifecycle.test.ts` — every pre-existing scenario that
  used to complete automatically within one `start()` call was rewritten
  to the new pause-then-`resume({ pin })` shape; none of their underlying
  assertions (crash recovery, cancellation, no-duplicate-execution,
  workspace preservation) changed.

## Explicitly not built this phase

- Auto-opening the destination app after seeding — a seeded session is
  announced ready, but `handoff open` stays a separate, manual step, per
  the choice made for this phase.
- Any notification from the foreground `auto start`/`auto resume` CLI
  path — daemon-only.
- A real live test of `terminal-notifier`'s actual response format —
  needs `brew install terminal-notifier` first, then a separate, explicit
  live-verification step after this lands.
