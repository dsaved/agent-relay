# Agent Relay

Agent Relay coordinates coding tasks between the Codex and Claude Code
CLIs — detecting when one is rate-limited or has crashed and
automatically continuing the work on the other — using only each tool's
existing **subscription authentication**. No API keys, no model SDKs, no
pay-per-token billing, anywhere in this project.

It runs as a small background daemon (optionally managed by macOS
`launchd`) that a lightweight CLI talks to over a local Unix socket, so a
task keeps running after the command that started it has exited.

> **Status**: not yet published to npm (see `docs/RELEASE.md`). Install
> from a local build/tarball for now. Automatic handoff from an
> *independently running* desktop session (one Agent Relay didn't start)
> is not yet fully verified end-to-end — see `docs/INTEGRATIONS.md` for
> exactly what that means and what is verified instead.

## Requirements

- macOS, Node.js `>=22`
- The Claude Code CLI and/or Codex CLI, each already authenticated via
  its own subscription (`claude auth status` / `codex login status`) —
  neither is required just to install Agent Relay itself

## Install

Agent Relay isn't on the npm registry yet. Build and install from a
local tarball:

```bash
git clone <this repository>
cd agent-relay
npm install
npm run build
npm pack
npm install -g ./agent-relay-0.1.0.tgz
```

See `docs/INSTALLATION.md` for how to verify the tarball's contents and
how to test a global install in a fully isolated environment (what this
project's own test suite does on every run) before installing onto your
real machine.

## Onboarding example

A complete first run, start to finish:

```bash
# 1. See what Agent Relay would detect and change, without changing anything yet.
agent-relay setup --yes
```

```
environment: platform: darwin; node v22.5.0 satisfies the required >=22
auth [claude]: authenticated via claude.ai (pro)
auth [codex]: authenticated via ChatGPT

[claude-code] claude CLI found (2.1.308 (Claude Code))
  + Add a Stop hook to /Users/you/.claude/settings.json running: "/usr/local/bin/node" "/usr/local/lib/node_modules/agent-relay/dist/src/cli.js" desktop hook-event
  + Add a SessionEnd hook to /Users/you/.claude/settings.json running: ...
[codex] codex CLI found (0.159.2)
  (not installed — nothing to plan)
[daemon-launchd] macOS detected — launchd plist can be installed
  + Write the launchd plist at /Users/you/Library/LaunchAgents/com.agent-relay.daemon.plist

[claude-code] Added a Stop hook to /Users/you/.claude/settings.json ...
[claude-code]   backup saved: /Users/you/.claude/settings.json.bak-2026-11-10T...
[claude-code] Added a SessionEnd hook to /Users/you/.claude/settings.json ...
[daemon-launchd] Wrote the launchd plist at /Users/you/Library/LaunchAgents/com.agent-relay.daemon.plist

Installation health:
environment: platform: darwin; ...
daemon: not running
[claude-code] installed: ...
[codex] not_applicable: ...
[daemon-launchd] installed: ...
config: valid
```

```bash
# 2. Start the daemon (manually; see docs/INTEGRATIONS.md for the launchd-managed alternative).
agent-relay daemon start
agent-relay daemon status

# 3. Prepare and submit a task from a discovered Codex/Claude session.
agent-relay sessions                       # list what's discoverable right now
agent-relay handoff prepare <session-id>   # builds a durable task from it
agent-relay auto start <task-id> --validate "npm test"

# 4. Check on it later -- from any terminal, even after the one that
#    started it is long gone, because the daemon kept running.
agent-relay auto status <task-id>
agent-relay auto history <task-id>

# 5. Pause/resume/stop it if needed.
agent-relay auto pause <task-id>
agent-relay auto resume <task-id>

# 6. Day-to-day health check.
agent-relay doctor
```

## What each piece does

| Command group | What it's for | Docs |
|---|---|---|
| `setup`, `integrations ...`, `config ...`, `doctor` | Detect, install, and manage integrations | `docs/SETUP.md`, `docs/INTEGRATIONS.md` |
| `daemon ...` | Start/stop/activate/deactivate the background service | `docs/DAEMON.md`, `docs/INTEGRATIONS.md` |
| `sessions`, `inspect`, `handoff ...` | Discover and prepare cross-provider handoffs | `docs/SESSION_DISCOVERY.md`, `docs/HANDOFF_ENGINE.md` |
| `auto ...` | Automatic bidirectional handoff supervision of one task | `docs/AUTOMATIC_HANDOFF.md` |
| `desktop ...` | Track and safely transfer ownership of desktop-originated sessions | `docs/DESKTOP_INTEGRATION.md` |
| `usage ...` | Zero-cost subscription usage/rate-limit checks | `docs/FEASIBILITY.md` (Phases 1A/1B) |

Run `agent-relay` with no arguments for the full command list.

## Removal

```bash
agent-relay integrations uninstall
agent-relay daemon stop   # or: agent-relay daemon deactivate
npm uninstall -g agent-relay
```

See `docs/UNINSTALL.md` for exactly what gets removed, what's
deliberately left alone, and how to verify a clean removal.

## Safety and scope

- Subscription-authenticated CLIs only — this project never asks for or
  stores an API key.
- Every write to your real configuration (`~/.claude/settings.json`, the
  launchd plist) backs up the file first, preserves everything it didn't
  add, and only ever happens after you've approved `setup`'s printed
  plan (`--yes`, or an interactive prompt) — never automatically through
  `npm install`.
- `agent-relay integrations uninstall` removes only entries this tool
  itself added, identified by its own marker — never a blind revert.
- See `docs/FEASIBILITY.md` for the full, phase-by-phase history of what
  this project has verified, including every capability it has
  explicitly reported as unsupported or unverified rather than claimed.

## Documentation index

`docs/FEASIBILITY.md` is the master index of every development phase and
its capability matrix. Individual docs: `INSTALLATION.md`, `SETUP.md`,
`INTEGRATIONS.md`, `UNINSTALL.md`, `RELEASE.md`, `DAEMON.md`,
`DESKTOP_INTEGRATION.md`, `SESSION_DISCOVERY.md`, `HANDOFF_ENGINE.md`,
`AUTOMATIC_HANDOFF.md`.
