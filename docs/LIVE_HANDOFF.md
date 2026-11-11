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
`copilot --help` (read-only). The Claude row below was then **live-tested**
on a real install — see "Live-verified findings."

| Provider | Primitive | What `handoff open` does |
|---|---|---|
| **Claude** | `--desktop` flag: "Open in the Claude Desktop app instead of the terminal (with `--continue` or `--resume <id>` to pick the session)" | `claude --desktop [--resume <id>]`, fired detached, **never with a prompt** (see below — the CLI refuses one). Opens the Claude Desktop app on the resumed session (or a brand-new one); the instruction is never seeded and is printed for the person to paste in themselves. |
| **Codex** | `codex queue --thread <id> --message <text>` ("Queue a message for an existing session") + `codex app [PATH]` ("Launch the Desktop app") | With a known thread: `codex queue --thread <id> --message "<instruction>"` (headless, quick, capturable exit code), then `codex app <cwd>` fired detached to bring the app forward. With no known thread yet: only `codex app <cwd>` fires — there's no documented way to seed a brand-new thread's first message from outside, so the instruction is **not** seeded; the result says so plainly. |
| **Copilot** | None found | `copilot app` only opens the app for a directory, with no session targeting; `copilot sessions` has only an `import` subcommand; `--resume` is terminal-only, no desktop equivalent. `handoff open --to copilot` is refused by `openHandoffLive` itself (no adapter registered), with a message pointing at `handoff execute` — same mechanism that would refuse any future provider with no `LiveOpenAdapter`. |

## Live-verified findings

- **`claude --desktop` flatly refuses a prompt argument.** Confirmed on a
  real install: `claude --desktop "ping test"` exits immediately with
  `--desktop doesn't take a prompt yet. Run \`claude --desktop\`, then type
  it in the app.` So the `--help` text's "with `--continue` or `--resume
  <id>` to pick the session" is only about *which session*, never about
  seeding its first message. `ClaudeLiveOpenAdapter` never passes the
  instruction as an argument; `LiveOpenResult.seeded` is always `false` for
  Claude, and `handoff open`'s CLI output prints the instruction text so it
  can be pasted into the app by hand.
- Also confirmed: the Claude Desktop app itself was already installed and
  running when this was tested, so "the app isn't open" is not what blocks
  seeding — the CLI's own `--desktop` flag rejects the prompt outright,
  independent of whether the app is running.
- **`claude --desktop` refuses to run at all with redirected stdio.**
  Live-tested in two rounds: first with the original `launchDetached`
  (`detached: true, stdio: "ignore"`) — nothing visible happened, process
  reported `launched: true`. Switching to piped stdio (to capture stderr
  for diagnosis) surfaced the real cause: `--desktop opens the Claude
  Desktop app and can't run non-interactively (--print, --sdk-url,
  --init-only, or redirected output)`. `--desktop` checks whether its own
  stdio looks like a real terminal and refuses outright if not — both
  "ignore" and "pipe" count as redirected. `launchDetached` now uses
  `stdio: "inherit"`, which keeps the child's streams genuinely attached
  to the terminal `agent-relay` itself was run from. `unref()` alone is
  enough to let `agent-relay` exit without waiting on the child;
  inherited file descriptors stay valid for it regardless. One
  consequence: `agent-relay` can no longer capture this command's own
  output — anything it prints goes straight to the person's terminal in
  real time instead, which is what let this exact bug surface.

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

## Live-verified: the Claude open path works end to end

`agent-relay handoff open <id> --to claude` genuinely opens a new Claude
Desktop window, confirmed on a real repo (`sunbeam`) after the
`stdio: "inherit"` fix above. Claude opened its own fresh worktree on an
auto-generated branch (its own default isolation behavior, not something
`agent-relay` controls or needs to) and, with no instruction seeded,
correctly reported nothing in progress and asked what to work on — exactly
the expected behavior given `--desktop` can't take a prompt. Pasting the
printed instruction block into that conversation is the one manual step
left, and `handoff open`'s own CLI output exists specifically to make that
copy-paste trivial.

## Unverified — pending a separate, explicit live check

- Does `--desktop --resume <id>` correctly reopen that exact session
  (rather than a fresh worktree) on a second `handoff open` call?
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
