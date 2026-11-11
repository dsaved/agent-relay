# Removal

Agent Relay is designed to be fully reversible: every integration it
installs can be removed independently, and removal never touches
anything it didn't itself add.

## Remove the Claude Code / daemon integrations

```bash
agent-relay integrations uninstall
```

Prompts for confirmation (or pass `--yes`). For each registered
integration:

- **Claude Code**: removes only the `Stop`/`SessionEnd` hook entries
  whose command carries Agent Relay's own marker (`desktop hook-event`)
  — an entry you wrote yourself, even one that happens to also run
  something else alongside, is left alone. Everything else in
  `~/.claude/settings.json` (other hooks, `permissions`, `model`, any
  other key) is untouched, and the file's permission mode is preserved.
  A backup (`<path>.bak-<timestamp>`) is written first, same as every
  other write this tool makes to that file.
- **launchd plist**: removes `~/Library/LaunchAgents/com.agent-relay.daemon.plist`
  (backed up first). **This does not unload the service if it's
  currently loaded** — if you ran `daemon activate` at some point, unload
  it first or after with:

  ```bash
  agent-relay daemon deactivate
  ```

  (idempotent — a no-op if it was never loaded).
- **Codex**: nothing to remove — it was never written to in the first
  place (`docs/INTEGRATIONS.md`).

## Stop the daemon

```bash
agent-relay daemon stop       # if started manually
agent-relay daemon deactivate # if launchd-managed (also stops it)
```

Both wait for the daemon to actually stop answering before returning.

## Uninstall with active tasks

`integrations uninstall` only touches integration config (hooks,
plist) — it never touches `~/.agent-relay`'s task/handoff state, and it
does not require the daemon to be stopped first. If a task is genuinely
mid-execution when you uninstall the Claude Code hook, that task's own
execution is unaffected (the hook is a separate, passive session-tracking
mechanism, not part of the handoff engine's own execution path) — it
simply stops receiving `Stop`/`SessionEnd` evidence going forward.

## Remove the npm package itself

```bash
npm uninstall -g agent-relay
```

This does **not** automatically run `integrations uninstall` or
`daemon deactivate` first — per this project's own restriction ("Install
hooks only during the explicitly approved setup process, never
automatically through `npm install`"), the inverse holds too: nothing
here hooks into `npm uninstall` to silently reach into your Claude Code
settings or launchd. Run `agent-relay integrations uninstall` (and
`daemon deactivate`, if applicable) yourself first if you want those
cleaned up before removing the package.

## Remove all persisted state

Task/handoff history, logs, and the desktop-session registry live under
`~/.agent-relay` (or `$AGENT_RELAY_HOME`, if you set it). This is this
tool's own bookkeeping, never a modification of your project or your
other applications' configuration — delete it directly if you want a
completely clean slate:

```bash
rm -rf ~/.agent-relay
```

## Verifying a clean removal

`agent-relay integrations status` after uninstalling should report every
Claude Code hook and the launchd plist as `missing`. A full round-trip —
install from a tarball, set up against a disposable fixture, uninstall,
and confirm the fixture's unrelated settings/hooks survived exactly as
seeded — is exercised for real in `test/integrationLifecycle.test.ts`
every time the test suite runs.

## Capability matrix

| # | Capability | Status | Evidence |
|---|---|---|---|
| U.1 | Uninstall removes only Agent Relay's own entries | **VERIFIED** | `test/setupClaudeAdapter.test.ts` ("uninstall(): removes only our own hook entries...") |
| U.2 | Unrelated settings/hooks/permissions survive uninstall | **VERIFIED** | `test/integrationLifecycle.test.ts` (end-to-end, real installed binary) |
| U.3 | File permissions preserved through uninstall's write | **VERIFIED** | `src/setup/claudeCodeAdapter.ts`'s shared `backupThenWrite` path, same as `apply()` |
| U.4 | Uninstall with an active task doesn't disturb its execution | **VERIFIED** (by construction — uninstall touches only config files, never `~/.agent-relay`'s task/handoff/lock state) | `src/setup/claudeCodeAdapter.ts`/`daemonAdapter.ts` — neither imports anything from `src/handoff/`'s state-mutating paths |
| U.5 | Removal is fully reversible (re-running `setup` restores it) | **VERIFIED** | Idempotency tests double as this — `apply()` after `uninstall()` is just another `apply()` |
