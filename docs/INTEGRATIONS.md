# Integrations

What Agent Relay actually integrates with, exactly how, and — just as
important — what it honestly cannot do yet.

## Claude Code

Managed by `src/setup/claudeCodeAdapter.ts` (`ClaudeCodeAdapter`). Installs
one hook entry per event in `MANAGED_HOOK_EVENTS` (`Stop`, `SessionEnd`)
into `~/.claude/settings.json`, each running:

```
"<absolute node path>" "<absolute cli.js path>" desktop hook-event
```

with a `"timeout": 5` (seconds) so a stuck receiver can never block or
interrupt a real Claude Code session. The receiver itself
(`agent-relay desktop hook-event`, `src/desktop/registry.ts`) only ever
*appends evidence* to the matching registered desktop session — **it
never treats a `Stop` (or any other) hook event as proof that a task is
complete, that subscription usage is exhausted, or that workspace
ownership has been relinquished.** That's enforced directly, not just
documented: `test/hookEventNeverInfers.test.ts` asserts a `Stop` event
changes nothing about a session's `ownershipStatus`/`observedActivity`,
only its evidence trail.

Managing it:

```bash
agent-relay setup                      # detect + propose + apply, on approval
agent-relay integrations status        # per-event: installed / missing / broken
agent-relay integrations repair        # fixes only what's missing/broken
agent-relay integrations uninstall     # removes only Agent Relay's own hook entries
```

Every write backs up the file first (`<path>.bak-<timestamp>`), preserves
every unrelated hook/setting/permission, preserves the file's original
permission mode, and is idempotent — running `setup` twice never
duplicates a hook. See `docs/SETUP.md` for exactly how each property is
enforced and tested.

## Codex

**Deliberately not an integration in the same sense.** Codex has no
documented hook or local config-file mechanism analogous to Claude Code's
— Phase 0 through this phase all confirm this, and this phase does not
invent an undocumented one or touch an undocumented private socket
(`~/.codex/app-server-control/`, `~/.codex/ipc/`) to work around it.
`agent-relay integrations status` reports Codex's entry as
`not_applicable`, honestly — not silently omitted, not faked as
"installed."

What *is* real and reused unchanged: session discovery
(`thread/list` over this project's own isolated `codex app-server
--stdio` process), account-level usage monitoring
(`account/rateLimits/read`, zero-cost, no model prompt), and project/
worktree association. See `docs/FEASIBILITY.md` Phases 0/1A/2A for the
original verification of each.

## Desktop activity detection — stated limitation

**Automatic handoff from an independently running desktop session (a
live Codex Desktop or Claude Desktop Code-tab session that Agent Relay
did not start) is not yet fully verified end-to-end.** Specifically:

- Codex's own discovery interface (`thread/list`) cannot distinguish "a
  thread that's genuinely active right now" from "a thread that existed
  and finished yesterday" — only the documented, in-memory-scoped
  `thread/loaded/list` request could, and that's scoped to whichever
  process calls it, not the real shared daemon Codex Desktop itself uses
  (querying that daemon directly would require an undocumented private
  socket, which this project does not do). The practical result,
  unchanged since Phase 2A/2C: any workspace with Codex history reports
  `external_unknown`, and automatic ownership transfer is refused there
  by design, every time, without an explicit human override.
- Claude's `claude agents --json` *is* a genuine, real-time liveness
  signal (Phase 0 confirmed this), so a desktop Claude Code session
  Agent Relay didn't start is at least correctly detectable as busy or
  idle — but a *live*, real end-to-end demonstration of automatically
  handing off work away from such a session, with real subscription
  calls on both sides, has not been run in any phase so far (Phase 3B
  explicitly scoped this out; this phase doesn't add it either).
- Everything that *has* been verified end-to-end — a Relay-managed task
  started by Agent Relay itself, interrupted, resumed, and recovered
  after a crash — is proven for real in `test/integrationLifecycle.test.ts`,
  using a scripted stand-in for the coding-agent CLI rather than a real
  model call (per this project's own restriction). That is a different,
  narrower claim than "automatic handoff from an independently running
  desktop session," and this document does not conflate the two.

## launchd: manual vs. launchd-managed lifecycle

Two different ways the daemon can be running, and only one should be in
charge of a given state directory at a time:

| | Command | Who restarts it on a crash? | Who starts it at login? |
|---|---|---|---|
| Manual | `agent-relay daemon start`/`stop` | Nobody — you run `start` again | Nobody |
| launchd-managed | `agent-relay daemon activate`/`deactivate` | launchd (`KeepAlive`, crash-only) | launchd (`RunAtLoad`) |

`agent-relay daemon install` only **writes** the plist
(`~/Library/LaunchAgents/com.agent-relay.daemon.plist`) — it never calls
`launchctl` itself. `agent-relay daemon activate` is the explicit,
separate step that actually loads it (`launchctl bootstrap`), and is
idempotent — a no-op, not an error, if already loaded.
`agent-relay daemon deactivate` unloads it (`launchctl bootout`),
likewise idempotent. **`daemon start` refuses if launchd already has the
service loaded** — it checks `launchctl print` (read-only) first and
points you at `daemon restart`/`activate` instead, specifically to avoid
two lifecycle owners racing for the same state directory. The daemon's
own single-instance socket guard (Phase 4) still catches the case even if
that check is ever wrong, so nothing regresses if it is.

**None of this phase's testing ever ran a real `launchctl` command
against this machine's actual launchd** — `activate`/`deactivate`/the
loaded-check all go through an injectable runner, and every test injects
a fake one. See `docs/UNINSTALL.md` for what removing a launchd-managed
install looks like.

## Capability matrix

| # | Capability | Status | Evidence |
|---|---|---|---|
| G.1 | Claude Code `Stop`/`SessionEnd` hooks, non-blocking | **VERIFIED** | `docs/SETUP.md` §Phase 6 additions |
| G.2 | A hook event is evidence only, never a completion/exhaustion/ownership signal | **VERIFIED** | `test/hookEventNeverInfers.test.ts` |
| G.3 | Codex has no hook mechanism, no undocumented socket | **VERIFIED** (by not building one) | `src/setup/codexAdapter.ts` |
| G.4 | Automatic handoff from an independently running desktop session | **UNVERIFIED — explicitly stated, not claimed** | This section |
| G.5 | launchd activate/deactivate, idempotent, never run for real in testing | **VERIFIED** (logic, against a fake runner) | `test/launchdActivation.test.ts` |
| G.6 | Single lifecycle owner (manual vs. launchd-managed) | **VERIFIED** (the refusal check); real launchd contention itself is not independently reproducible without loading a real service, which this project does not do | `src/cli.ts`'s `daemonStartCommand` |
