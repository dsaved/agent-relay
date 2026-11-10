# Phase 2A — Desktop Session Discovery and Safe Handoff

Goal: prove that unfinished tasks started in Codex Desktop or Claude
Desktop (Code tab) can be *discovered*, *associated with their
repository*, and *safely inspected* by their subscription-authenticated
CLI — without automatic handoff, without any write to a user's repo, and
without touching anything we don't own. This phase builds the read-only
pieces and runs one real, user-approved, fully disposable end-to-end
continuation test; it does **not** build or enable automatic agent
switching.

## 1. Session discovery

| Provider | Mechanism | Module |
|---|---|---|
| Claude | `claude agents --json` (documented, read-only, no model prompt — Phase 0 #11) | [`src/sessions/claudeDiscovery.ts`](../src/sessions/claudeDiscovery.ts) |
| Codex | `thread/list` over the `app-server` JSON-RPC protocol (documented via `codex app-server generate-json-schema`), called over this project's own **isolated** `codex app-server --stdio` process (same safety posture as Phase 1A/1B — never the shared daemon Desktop itself uses) | [`src/sessions/codexDiscovery.ts`](../src/sessions/codexDiscovery.ts) |

Both adapters return `{ sessions: DiscoveredSession[], error?: string }`
and never throw: a missing CLI, a malformed/unexpected response shape, or
a transport failure is reported in `error` with an empty session list.

### Captured fields (per the task's required list)

| Required field | Claude source | Codex source |
|---|---|---|
| Provider | literal `"claude"` | literal `"codex"` |
| Session/thread identifier | `sessionId` | `sessionId` (falls back to `id`) |
| Project directory | `cwd` | `cwd` |
| Git worktree path, when available | *(computed in association step — see §2)* | *(computed in association step)* |
| Process identifier, when available | `pid` (claude lists live OS processes) | **not available** — `thread/list` is a persisted-metadata read, not a process list; always `null` (see "Known limitations" below) |
| Observed session status | `status` (`"idle"`/`"busy"`) | `status.type` (`"notLoaded"`/`"idle"`/`"active"`/`"systemError"`) |
| Last observed activity | `startedAt` (epoch ms) | `recencyAt`, falling back to `updatedAt` (both converted from epoch seconds to ms) |
| Discovery source | `"claude-cli:agents --json"` | `"codex-app-server:thread/list"`, with `(source / originator)` appended when the thread records one, e.g. `"(vscode / Codex Desktop)"` |

### Known limitations (reported honestly, not glossed over)

- **Codex `pid` is always `null`.** `thread/list` is a read of persisted
  thread metadata (what the task calls "documented session-discovery
  mechanisms"), not a live process table. There is no documented Codex
  equivalent of `claude agents --json`'s OS-level process enumeration.
- **Codex `status` is not a live-activity signal from this discovery
  path.** Every thread this session queried — dozens of real,
  previously-used threads across several of this machine's other
  projects — reported `status.type: "notLoaded"`, including ones known
  to be recently active. That's because `thread/list` reads a
  shared on-disk index, while "is this thread loaded in memory *right
  now*" is answered by a **different**, in-memory-scoped request,
  `thread/loaded/list` — which this adapter deliberately does not call
  against the real shared daemon. See "Why we don't check true Codex
  liveness" below.
- **Claude's `status` ("idle"/"busy") IS a live signal**, because
  `claude agents --json` only lists sessions whose OS process is
  currently running — there's no separate "loaded vs. not" distinction
  to miss.
- **Claude's `lastActivity` is session-start time, not last-message
  time.** `claude agents --json` has no separate "last activity"
  timestamp field as of this CLI version; `startedAt` is the closest
  thing it reports.

### Why we don't check true Codex liveness

Codex's `thread/loaded/list` request (also documented in the app-server
schema) returns the thread IDs loaded in memory — but *in the memory of
whichever app-server process answers it*. Tested live against this
adapter's own isolated `--stdio` process, it correctly came back empty
(`{"data": []}`) — nothing is loaded in a process we just spawned and
haven't loaded anything into. To get the *real* answer — what's loaded in
the actual shared daemon that Codex Desktop talks to — would mean
connecting to that daemon's own control socket
(`~/.codex/app-server-control/app-server-control.sock`) or the IPC socket
Desktop itself uses (`~/.codex/ipc/ipc.sock`). The task restricts exactly
that ("no undocumented desktop IPC access", "never attach to a user's
active development session"), so this adapter doesn't do it. The
practical consequence: **this discovery path cannot prove a specific
Codex thread is currently idle, only that it exists and when it was last
updated.** Treat `status: "notLoaded"` as "not loaded in *our* process",
not as "idle in Desktop."

## 2. Project association

[`src/sessions/projectAssociation.ts`](../src/sessions/projectAssociation.ts):

- **Repository root + worktree detection** (`detectWorktreeInfo`): runs
  `git rev-parse --show-toplevel` at the session's `projectDir`, then
  distinguishes a linked worktree from the main one by checking whether
  that toplevel's `.git` is a *file* (linked worktree — git points it at
  `<main-repo>/.git/worktrees/<name>`) or a *directory* (the main
  worktree). For a linked worktree, the main repo root comes from
  `git rev-parse --git-common-dir`. Only `git` plumbing commands are
  used — nothing provider-specific, nothing written.
- **Workspace accessibility** (`isWorkspaceAccessible`): a plain `stat`
  on `projectDir`; `false` only when the directory genuinely can't be
  read (deleted, unmounted, permissions), `null` when there's no
  `projectDir` to check at all. A session with a missing workspace is
  still reported — discovery never drops a record because its workspace
  vanished.
- **Deduplication** (`dedupeSessions`): collapses repeat
  `provider:sessionId` pairs before association, so a provider quirk
  that lists the same thread twice doesn't produce two association
  records.
- **Grouping** (`groupByProject`): sessions are grouped by `repoRoot`
  purely as a *view* — **nothing here merges or infers that two sessions
  in the same repo are the same task.** Two sessions under one
  `repoRoot` remain two separate `SessionAssociation` records in that
  group's array; see `test/projectAssociation.test.ts` for a test that
  asserts this explicitly.
- **Multiple sessions per project**: this live machine had real,
  concrete proof: `agent-relay sessions --project <a project with both a
  main checkout and a Claude-created worktree>` returned **18** sessions
  correctly grouped under one `repoRoot`, spanning both providers and
  both the main checkout and the linked worktree, each kept as its own
  entry (see §5 for the sanitized version of this result — the real
  project name isn't reproduced here deliberately).

## 3. Safe handoff snapshot

[`src/sessions/handoff.ts`](../src/sessions/handoff.ts),
`prepareHandoffSnapshot(session)`:

- Runs exactly three read-only `git` commands against the session's
  worktree (or repo root, if it has none): `status --porcelain=v1`,
  `branch --show-current`, `rev-parse HEAD`. Nothing else. No reset, no
  clean, no checkout, no commit, no push — the function contains no code
  path that invokes any of them.
- **Does not run the project's own build/test commands.** Even read-only
  in intent, executing someone else's `npm test` as a side effect of
  "inspecting" their session would be exactly the kind of unrequested
  action the task's own safety framing warns against. `validationResults`
  is therefore always `null` in this phase — there's no mechanism yet
  that produces or stores one.
- **Never infers completeness from file state.** There is no `complete`,
  `done`, or similar field anywhere in `HandoffSnapshot` — see
  `test/handoff.test.ts`'s explicit assertion that no such field exists.
  Modified/untracked files are reported with their raw
  `git status --porcelain=v1` codes, as facts, full stop.
- `availableTaskDescription` is the provider's own recorded title
  (Claude: `name`; Codex: `name`), never a generated summary.
- `availableProgressInformation` is `null` unless the provider itself
  reports something structured — currently only Codex's last known
  thread status, surfaced verbatim, not interpreted.

## 4. Disposable session continuation test (live, user-approved)

Run on 2026-11-10 in a throwaway git repo under this machine's temp
directory, created and destroyed solely for this test, never inside any
real project. Explicit approval for live model calls on both providers
was obtained from the user before running this.

**Claude:**
1. `claude -p --session-id <fixed-uuid> --permission-mode acceptEdits "Create a file named step1.txt containing exactly: STEP ONE COMPLETE"` → file created, confirmed on disk; `-p` exits on completion, which *is* "stopping cleanly" for a non-interactive session (there is no lingering process to separately stop).
2. `claude -p --resume <same-uuid> "Without creating or editing anything, tell me: what filename did you just create, and what exact single line of text is inside it?"` → replied **"The filename is `step1.txt` and the exact line inside it is `STEP ONE COMPLETE`."** — correct, from context, not by re-reading the file (it was told not to touch anything).
3. **Result: VERIFIED.** Start → implementation step → clean stop → resume via `--resume` → context intact.

**Codex:**
1. `codex exec --json "Create a file named codex-step1.txt containing exactly: CODEX STEP ONE COMPLETE"` → file created, confirmed on disk and via the turn's own `command_execution` verification step; captured `thread_id`.
2. `codex exec --json resume <thread_id> "Without creating or editing anything, tell me: what filename did you just create, and what exact single line of text is inside it?"` → replied **"Filename: `codex-step1.txt` / Exact line: `CODEX STEP ONE COMPLETE`"**, explicitly noting no files were touched for this response.
3. **Result: VERIFIED.** Same shape as Claude's, via `codex exec resume <thread_id>`.

Real, bounded cost for all four turns: ≈$0.32 total on Claude's two turns (reported `total_cost_usd`); Codex's two turns cost the account's own included usage (no separate price surfaced by `exec --json`). No further live calls were made beyond this.

A useful side effect: step 1 of the Codex test produced a real
`item.completed`/`type: "agent_message"` event — resolving
docs/FEASIBILITY.md Phase 0's item #7, which that phase could only
reconstruct from schema because every live call made then hit the
account's usage limit before completing a turn.

## 5. Desktop-originated session resumption — investigated, reported UNVERIFIED

The task asks whether a session **started in Codex Desktop or Claude
Desktop** can specifically be resumed by its CLI — not just whether
resume works at all (§4 already proves the generic mechanism). This is
reported **UNVERIFIED**, by deliberate choice, not oversight:

- This machine's real `thread/list` data includes genuine Desktop/IDE-
  originated Codex threads (`source: "vscode"`, `originator: "Codex
  Desktop"`) across several of this machine's other, real projects. The
  only way to test resuming one of *those* specific threads is to run
  `codex exec resume <that thread's id>` against someone's actual,
  existing project — which is a live write risk (the resumed agent could
  act, not just answer) against a repository this phase is explicitly
  forbidden from modifying. Not attempted.
- This very conversation is itself a live Claude Desktop Code-tab
  session, and `claude agents --json` (confirmed in Phase 0 and again
  here) lists it by the exact same `sessionId` scheme `--resume` takes —
  but it is this session, active, right now. Attempting
  `claude --resume` against it would be attaching to a user's active
  development session, which is explicitly forbidden. Not attempted.
- There is no way to fabricate a disposable thread whose `originator` is
  `"Codex Desktop"` (or Claude's Desktop equivalent) from the CLI alone —
  that provenance is set by whichever real client created the thread,
  not by a flag this adapter can pass.

What *is* verified: the resume mechanism itself (§4), and that Desktop-
originated threads are discoverable by the same documented interface and
carry the same kind of session identifier (§1). What remains unverified
is specifically whether resuming one, rather than a CLI-originated one,
behaves identically — architecturally plausible (same ID namespace, same
`resume` command, same underlying thread storage), but not safely
testable within this phase's restrictions.

## 6. CLI commands (all read-only in this phase)

```
agent-relay sessions                           # all discovered sessions, both providers
agent-relay sessions --provider claude          # filter by provider
agent-relay sessions --provider codex
agent-relay sessions --project /path/to/project # filter to one repo's sessions (resolves worktrees)
agent-relay inspect <session-id>                # full detail for one session; exits 1 if not found
agent-relay handoff prepare <session-id>        # read-only handoff snapshot; exits 1 if not found
```

None of these commands write to a repository, start a session, or touch
an existing user project beyond running the three read-only `git`
commands listed in §3 against whatever directory the *discovered
session itself* already points at.

## 7. Capability matrix

| # | Capability | Status | Evidence |
|---|---|---|---|
| 2A.1 | Claude session discovery via documented CLI interface | **VERIFIED** | `claude agents --json`; live-tested, 5 real sessions discovered on this machine (details not reproduced verbatim — see §1 note on sanitization) |
| 2A.2 | Codex session discovery via documented app-server interface | **VERIFIED** | `thread/list`; live-tested, 50 real threads discovered, including genuine Desktop/IDE-originated ones identifiable via `source`/`originator` |
| 2A.3 | Codex process identifier capture | **UNSUPPORTED** | `thread/list` reports no OS pid; no documented Codex mechanism for this was found |
| 2A.4 | Codex live-activity (vs. persisted-metadata) status | **UNSUPPORTED** (by this adapter's design) | See §1, "Why we don't check true Codex liveness" — the documented request that would answer this (`thread/loaded/list`) is scoped to our own isolated process, not the real shared daemon, and querying the real one is out of scope per the no-undocumented-IPC / no-active-session-interference restrictions |
| 2A.5 | Repository root + worktree detection | **VERIFIED** | `git` plumbing only; unit-tested against disposable repos with and without a linked worktree, and live-verified against this machine's real multi-worktree projects |
| 2A.6 | Multiple sessions associated with one project | **VERIFIED** | Live: 18 real sessions (both providers) correctly grouped under one `repoRoot`; unit-tested with disposable repos |
| 2A.7 | Missing/inaccessible workspace detection | **VERIFIED** | Unit-tested; `workspaceAccessible: false` for a nonexistent directory, without blocking association of other sessions |
| 2A.8 | Sessions never assumed related solely by shared repo | **VERIFIED** | By construction — `groupByProject` only groups for display; unit-tested explicitly |
| 2A.9 | Safe, read-only handoff snapshot | **VERIFIED** | Unit-tested (clean repo, dirty repo, no-git session) and live-verified against a real project's worktree session |
| 2A.10 | Handoff snapshot never infers task completeness | **VERIFIED** | No such field exists in `HandoffSnapshot`; asserted directly in tests |
| 2A.11 | Disposable Claude session: start → step → stop → resume → context retained | **VERIFIED** (live) | §4 |
| 2A.12 | Disposable Codex session: start → step → stop → resume → context retained | **VERIFIED** (live) | §4 |
| 2A.13 | Desktop-originated session resumable by its CLI | **UNVERIFIED** (deliberately not attempted) | §5 — testing it safely would require either modifying a real existing project or attaching to this session's own live Desktop tab, both explicitly restricted |
| 2A.14 | Invalid session identifiers handled gracefully | **VERIFIED** | `inspect`/`handoff prepare` report "not found" with exit code 1, never a stack trace; unit- and CLI-level tested |
| 2A.15 | Malformed CLI/RPC output handled without crashing | **VERIFIED** | Unit-tested for both providers (non-JSON, non-array, missing `data` field) |
| 2A.16 | Unavailable CLI binary handled without crashing | **VERIFIED** | Unit-tested for both providers (spawn/transport rejection mapped to a reported error) |
| 2A.17 | Duplicate session records handled | **VERIFIED** | Unit-tested: discovery passes duplicates through unchanged; `dedupeSessions` (used by association) collapses them |

## 8. Restrictions honored

- Subscription auth only; the two live continuation-test turns used the
  same `claude -p`/`codex exec` subscription paths verified in Phases
  0–1B, nothing else.
- No credential files read; no socket beyond this adapter's own isolated
  `codex app-server --stdio` process (never the shared daemon/IPC
  sockets at `~/.codex/app-server-control/` or `~/.codex/ipc/`).
- No `git reset`, `clean`, `checkout`, `commit`, or `push` anywhere in
  this phase's code — `projectAssociation.ts` and `handoff.ts` between
  them run exactly five distinct read-only `git` subcommands
  (`rev-parse --show-toplevel`, `rev-parse --git-common-dir`,
  `status --porcelain=v1`, `branch --show-current`, `rev-parse HEAD`).
- No existing user project was modified. The only writes in this entire
  phase happened inside the disposable, throwaway repo created and
  destroyed for §4, and inside this `agent-relay` project itself.
- No automatic handoff or agent switching was built; `handoff prepare`
  only reads and reports.
