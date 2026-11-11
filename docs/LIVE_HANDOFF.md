# Phase 8 — Live App Handoff

`agent-relay handoff execute` is deliberately headless: it spawns a brand-
new, non-interactive CLI process, waits for it to exit, and captures the
result — nothing ever appears in an app window. That's a real gap if what
you actually want is to see a handoff land somewhere you can keep working
on it. This phase adds that second path.

```
agent-relay handoff open <handoff-id> --to <claude|codex> [--objective "..."] [--force-open]
```

Unlike `execute`, this doesn't wait for anything to finish — it launches a
**visible, human-driven** session in the destination's own app and hands
the workspace to you. There is no captured outcome, because nobody but you
knows when a live session you're looking at is "done."

## What's real, per provider

Found by reading this machine's real `claude --help`/`codex --help`/
`copilot --help` (read-only — nothing was executed to produce this table).
None of it has been run live yet; see "Unverified" below.

| Provider | Primitive | What `handoff open` does |
|---|---|---|
| **Claude** | `--desktop` flag: "Open in the Claude Desktop app instead of the terminal (with `--continue` or `--resume <id>` to pick the session)" | `claude --desktop [--resume <id>] "<instruction>"`, fired detached. Opens the actual Claude Desktop app window, on the resumed session (or a brand-new one), with the instruction as the next/first message. |
| **Codex** | `codex queue --thread <id> --message <text>` ("Queue a message for an existing session") + `codex app [PATH]` ("Launch the Desktop app") | With a known thread: `codex queue --thread <id> --message "<instruction>"` (headless, quick, capturable exit code), then `codex app <cwd>` fired detached to bring the app forward. With no known thread yet: only `codex app <cwd>` fires — there's no documented way to seed a brand-new thread's first message from outside, so the instruction is **not** seeded; the result says so plainly. |
| **Copilot** | None found | `copilot app` only opens the app for a directory, with no session targeting; `copilot sessions` has only an `import` subcommand; `--resume` is terminal-only, no desktop equivalent. `handoff open --to copilot` is refused by `openHandoffLive` itself (no adapter registered), with a message pointing at `handoff execute` — same mechanism that would refuse any future provider with no `LiveOpenAdapter`. |

## Safety model

Reuses Phase 2C/3B's existing primitives rather than inventing new ones:

1. The same activity check `handoff execute` runs
   (`defaultCheckProviderActivity`/`classifyWorkspaceActivity`,
   `src/handoff/engine.ts`) runs before anything is launched.
   `confirmed_busy` without `--force-open` refuses, same discipline as
   every other unsafe-takeover refusal in this codebase.
2. **No workspace lock is held.** `execute` holds `WorkspaceLockManager`'s
   lock until a captured outcome comes back; a live app session's
   completion is human-driven and indefinite, so holding a lock for that
   long would block every other guarded operation on the workspace
   forever. `handoff open` only runs the one-off activity check, then
   hands the workspace to the human.
3. On a successful launch, `src/desktop/registry.ts`'s
   `DesktopRegistry.registerFromHandoff()` immediately records a
   `DesktopSessionRecord` with `ownershipStatus: "external_active"` —
   never `relay_owned`, because Relay stops managing this workspace the
   moment the live session opens. `agent-relay desktop sessions`/`desktop
   inspect <id>` (unchanged, Phase 3B) is how you see it afterward; no new
   inspection command was added.
4. `HandoffRecord.status` gained one new value, `"opened_live"`
   (`src/handoff/types.ts`). It's never matched in an exhaustive switch
   anywhere in the codebase, and `AutomaticHandoffCoordinator` never calls
   this path at all — the automatic/headless flow is unaffected.
   `HandoffRecord.attempts` (shaped around a captured `ExecutionOutcome`)
   is left untouched; a live-open never produces one.
5. The continuation text itself is `buildContinuationInstruction()`
   (`src/handoff/instruction.ts`), completely unchanged — already
   provider-agnostic.

## Code map

- `src/execution/launchDetached.ts` — fire-and-forget launcher for
  GUI-opening commands. Deliberately separate from `spawnRun.ts`: there's
  nothing to wait for, so no timeout, no output capture, no process-group
  kill. Waits one short grace period for Node's own async spawn-error
  event (e.g. a missing binary) before reporting success, so a missing
  CLI is never reported as "launched."
- `src/execution/types.ts` — `LiveOpenOptions`/`LiveOpenResult`/
  `LiveOpenAdapter`, alongside the existing `AgentExecutionAdapter`
  (not a replacement).
- `src/execution/claudeLiveOpenAdapter.ts` / `codexLiveOpenAdapter.ts` —
  the two adapters above.
- `src/handoff/openHandoff.ts` — `openHandoffLive()`, the library function
  `handoff open` wraps. Mirrors `src/desktop/handoff.ts`'s
  `requestDesktopHandoff()` shape.
- `src/desktop/registry.ts` — `DesktopRegistry.registerFromHandoff()`,
  the one new method; everything else in that file is unchanged.

## Unverified — pending a separate, explicit live check

Same gate every live call in this project's history has gone through; not
run during this phase's planning or implementation:

- Does `claude --desktop` really accept a prompt together with
  `--resume`, and does it foreground an existing window or open a new one?
- Does `codex app <path>` auto-attach to an existing thread for that path,
  or always open blank?
- Does `codex queue` require the shared app-server daemon to already be
  running, and does queuing into a thread that's currently open in the
  Desktop app actually surface live, or only on next open?

## Explicitly not built this phase

- No Copilot live-open adapter — no real primitive exists to build one on
  (see table above). Documented the same way Windsurf/Kiro/Kilo Code are
  in `docs/MULTI_AGENT.md`.
- No change to `handoff execute`, `AutomaticHandoffCoordinator`, or any
  existing headless/automatic code path.
