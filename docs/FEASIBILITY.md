# agent-relay — Feasibility

This document covers two phases:

- **Phase 0** (below): breadth-first feasibility check across all four
  surfaces (Codex Desktop, Claude Desktop Code tab, Codex CLI, Claude Code
  CLI).
- **[Phase 1A](#phase-1a--codex-live-rate-limit-detection)**: a working,
  tested `CodexUsageMonitor` that resolves Phase 0's two open questions
  about Codex (#15, #16 below) by actually exercising the `app-server`
  protocol's `account/rateLimits/read` request live.
- **[Phase 1B](#phase-1b--claude-subscription-usage-monitoring)**: the
  Claude-side counterpart. Unlike Codex, no zero-turn endpoint exists for
  Claude, so `ClaudeUsageMonitor` is passive by design, and both monitors
  are unified behind one common `UsageMonitor` interface
  ([`src/usage/types.ts`](../src/usage/types.ts)).
- **Phase 2A** (session discovery, project association, safe read-only
  handoff, and a live disposable-session continuation test) has its own
  document, [`docs/SESSION_DISCOVERY.md`](SESSION_DISCOVERY.md) — it's
  long enough to deserve one. The summary matrix below links back to it.
- **Phase 2B** (the cross-provider handoff engine: durable persistence,
  workspace locking, real execution adapters, usage gating) also has its
  own document, [`docs/HANDOFF_ENGINE.md`](HANDOFF_ENGINE.md).
- **Phase 2C** (workspace-ownership hardening, plus live verification of
  both handoff directions with real subscription-authenticated CLI
  calls) is appended to that same document.
- **Phase 3A** (automatic bidirectional handoff orchestration) has its
  own document, [`docs/AUTOMATIC_HANDOFF.md`](AUTOMATIC_HANDOFF.md).
- **Phase 3B** (desktop session integration and safe ownership transfer)
  has its own document, [`docs/DESKTOP_INTEGRATION.md`](DESKTOP_INTEGRATION.md).
- **Phase 4** (persistent macOS background daemon) has its own document,
  [`docs/DAEMON.md`](DAEMON.md).
- **Phase 5** (setup & integration management) has its own document,
  [`docs/SETUP.md`](SETUP.md).
- **Phase 6** (automated setup & NPM packaging) extends that same
  document and adds [`docs/INSTALLATION.md`](INSTALLATION.md),
  [`docs/INTEGRATIONS.md`](INTEGRATIONS.md),
  [`docs/UNINSTALL.md`](UNINSTALL.md), and
  [`docs/RELEASE.md`](RELEASE.md).

## Phase 0 Feasibility

Scope: can an external process coordinate work across **Codex Desktop**, **Claude
Desktop (Code tab)**, **Codex CLI**, and **Claude Code CLI** on macOS, using only the
subscription auth each app already has (no API keys, no SDKs, no pay-per-token
billing)? This is a feasibility check, not an implementation. Adapter *interfaces*
are scaffolded in [`src/adapters/types.ts`](../src/adapters/types.ts); nothing in
`src/` talks to a real process beyond the one pure function
([`classifyRateLimit.ts`](../src/classifyRateLimit.ts)) needed to prove the
classification logic against real and mocked event data.

Environment this was verified against: macOS (Darwin 27.2.0), `codex-cli 0.159.2`,
Claude Code `2.1.308`, both installed via Homebrew, both authenticated via their
respective subscriptions (confirmed below — no API keys were present in the
environment and none were used).

## Method

- CLI capability claims come from each tool's own `--help` output, its `doctor`/
  `login status`/`auth status` subcommands, and (for Codex) the JSON Schema the CLI
  itself generates for its app-server protocol (`codex app-server
  generate-json-schema`) — all read-only, no model calls.
- Where a claim required seeing a real event stream, a single trivial prompt
  (`"Reply with exactly the word OK and nothing else."`) was run against each CLI
  from a throwaway git repo outside this project, **with the user's prior approval**
  for this bounded live usage. Codex's call landed on an already-exhausted usage
  window and failed before any model tokens were spent, which — serendipitously —
  produced the real "exhausted" event fixture. Claude's call succeeded (one cached
  invocation, ~$0.23 then ~$0.09 all-in; see `fixtures/README.md`). No further live
  calls were made once these fixtures were captured.
- Rate-limit *exhaustion* cases that weren't naturally reproducible without
  deliberately burning quota (e.g. Claude's `status: "rejected"`) are **mocked**,
  built to match the shape of the real "allowed" event with only the status/
  utilization fields flipped. These are flagged below and in `fixtures/README.md`.
- Per instructions, no private token/credential files were read (only their
  existence/permissions were checked, e.g. `~/.codex/auth.json` is `rw-------`),
  and no Desktop app's live session was attached to, inspected, or driven.

## Capability matrix

| # | Capability | Status | Evidence |
|---|---|---|---|
| 1 | Codex CLI installed, version discoverable | **VERIFIED** | `codex --version` → `codex-cli 0.159.2` |
| 2 | Claude Code CLI installed, version discoverable | **VERIFIED** | `claude --version` → `2.1.308 (Claude Code)` |
| 3 | Codex auth mode readable without exposing credentials | **VERIFIED** | `codex login status` → `Logged in using ChatGPT` (subscription, not API key; no token printed) |
| 4 | Claude auth mode readable without exposing credentials | **VERIFIED** | `claude auth status` → structured JSON: `authMethod: "claude.ai"`, `subscriptionType: "pro"`, `apiProvider: "firstParty"`; no token printed |
| 5 | Both CLIs confirmed on subscription auth, zero API keys in env | **VERIFIED** | Above, plus `env \| grep` for `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`CODEX_ACCESS_TOKEN` returned nothing |
| 6 | Codex CLI structured JSONL event output | **VERIFIED** | `codex exec --json` emits `thread.started` / `turn.started` / `item.completed` / `error` / `turn.failed` lines (real capture in `fixtures/codex-usage-limit.jsonl`) |
| 7 | Codex success-turn event shape (`item.type: "agent_message"`) | **UNVERIFIED** | Documented via `codex app-server generate-json-schema`, but never observed live — every live call during this session hit the account's exhausted usage window before producing one. `fixtures/codex-success.jsonl` is reconstructed from the schema, not captured |
| 8 | Claude CLI structured stream-json event output | **VERIFIED** | `claude -p --output-format stream-json` emits `system` (hook/init), `assistant`, `rate_limit_event`, `result` lines; real capture in `fixtures/claude-rate-limit-ok.jsonl` |
| 9 | Process execution: both CLIs runnable non-interactively, exit code + stdout/stderr usable | **VERIFIED** | `codex exec --json "..."`, `claude -p --output-format {json,stream-json} "..."` both ran as plain child processes with clean separation of event stream (stdout) and diagnostics (stderr) |
| 10 | Session references: stable, resumable session/thread IDs | **VERIFIED** | Codex: `thread_id` from `thread.started` resumed via `codex exec resume <id> "..."` (reached `turn.started` again). Claude: `session_id` is stable across all stream-json lines and accepted by `--resume`/`--session-id` |
| 11 | Session enumeration via documented CLI flag (no private files read) | **VERIFIED** | `claude agents --json` lists active sessions (pid, cwd, sessionId, status) across *all* projects on the machine, including this very session — confirming Desktop-tab sessions and terminal sessions share one enumerable namespace. (Output not reproduced verbatim in this doc — it named other unrelated local projects.) |
| 12 | Worktree creation via documented flag, independent of model call success | **VERIFIED** | `codex exec --json --worktree` created a real worktree at `~/.codex/worktrees/<hash>/<repo>` *even though the turn itself failed* on the usage-limit error — worktree setup happens before the model call. `claude --worktree -p` created `.claude/worktrees/<name>` inside the target repo on a `worktree-<name>` branch, visible in `git worktree list` as `locked`. Both cleaned up with `git worktree remove` after the test |
| 13 | Subscription-limit classification from structured fields (Claude) | **VERIFIED** | `rate_limit_event.rate_limit_info` carries `status` (`allowed`/…) and per-window `unifiedWindows.{five_hour,seven_day}.utilization`; `classifyRateLimit()` + tests in `test/classifyRateLimit.test.ts` consume this directly |
| 14 | Subscription-limit classification from structured fields (Codex, exec --json) | **UNSUPPORTED** | The `--json` stream has *no* structured rate-limit field — only a free-text `error`/`turn.failed` message ("You've hit your usage limit…"). Classification is necessarily regex-on-English-text (`classifyCodexLine` in `src/classifyRateLimit.ts`), which is locale/wording-fragile |
| 15 | Subscription-limit classification from structured fields (Codex, app-server protocol) | **VERIFIED** (resolved in Phase 1A) | `codex app-server generate-json-schema` documents `GetAccountRateLimitsResponse` / `AccountRateLimitsUpdatedNotification`. Phase 1A below opened the actual JSON-RPC channel and called `account/rateLimits/read` live against this machine's exhausted account — see that section for the transcript |
| 16 | Desktop-originated exhaustion detectable automatically, with zero model tokens spent | **VERIFIED** (resolved in Phase 1A) | Phase 1A's `account/rateLimits/read` call is a sibling of `exec`/`resume`, not a side effect of one — it never starts a turn. It reports account-level (not per-session) quota, so it reflects usage run up by *any* client, Desktop included |
| 17 | Documented CLI → Desktop handoff mechanism | **VERIFIED** (doc-level) | `claude --help` documents `--desktop` ("Open in the Claude Desktop app instead of the terminal, with `--continue`/`--resume <id>`"). `codex --help` documents `codex app [PATH]` ("Launch the Desktop app... Workspace path to open"). Neither was exercised (doing so would open a GUI window), but both are first-party, documented bridges confirming CLI and Desktop share session/workspace addressing |
| 18 | Desktop-originated task safely resumable by external CLI | **UNVERIFIED** | Supporting evidence points toward yes: `claude agents --json` (#11) already enumerates this very Desktop Code-tab session by the same `sessionId` scheme the terminal CLI's `--resume` takes, and `--desktop` (#17) proves the reverse direction works. This session deliberately did **not** attempt `claude --resume <id>` against a live/busy Desktop session, since doing so against an in-use session risked corrupting or interrupting real work — out of scope for a safe Phase 0 probe. Treat as a promising but unconfirmed path; Phase 1 should test it against an idle, disposable session |
| 19 | `codex agents` / Codex Desktop share a session daemon | **VERIFIED** (doc-level) | `codex agents --help`: "Browse all agent sessions on the **shared local app-server daemon**" — explicit first-party confirmation that Codex Desktop and Codex CLI are two clients of one local daemon, architecturally mirroring Claude's shared `~/.claude/projects` + `claude agents --json` model |
| 20 | Private credential files left unread | **VERIFIED** | Confirmed `~/.codex/auth.json` (mode `600`) and `~/.claude/.claude.json` exist via `ls -la` only; contents were never read. Auth state came entirely from `codex login status` / `claude auth status` |

## Key findings

1. **Both CLIs are fully usable non-interactively under pure subscription auth.**
   No API key was present, needed, or used anywhere in this investigation.
2. **Worktree creation and session-ID resumption are real, verified mechanisms on
   both tools**, and critically, worktree setup is decoupled from model-call
   success — so an orchestrator can provision an isolated worktree even while an
   account is rate-limited.
3. **Claude Code's event stream is the stronger integration surface for Phase 1.**
   It carries a structured, per-window rate-limit snapshot on *every* turn, keyed to
   a stable `session_id`, over a single documented flag (`--output-format
   stream-json`).
4. **Codex's `exec --json` stream is weaker for limit detection** (free-text
   matching only), but Codex exposes a materially better mechanism one layer down:
   the `app-server` JSON-RPC protocol's `GetAccountRateLimits` call. This is the
   single highest-value follow-up for Phase 1 — it is the only documented path to
   querying account exhaustion *without* spending a turn, and it's the same
   channel Codex Desktop itself must use.
5. **Cross-client session visibility is real but one-directional in what we could
   safely test.** We proved Desktop sessions are enumerable from the CLI
   (`claude agents --json`) and that the CLI can request a Desktop handoff
   (`--desktop`, `codex app`). We did not prove an external CLI can safely *attach
   mid-task* to a Desktop-originated session — that needs a disposable test session
   in Phase 1, not a live one.
6. **No automatic, zero-cost exhaustion probe exists today for either tool** from
   the CLI surface actually exercised in this session. Any Phase 1 polling loop
   either piggybacks on a real (if trivial) turn, or must be built against Codex's
   unexercised `app-server` protocol.

## Explicitly out of scope / not attempted

- Reading `~/.codex/auth.json` or any Claude keychain/token storage contents.
- Attaching to, inspecting, or resuming a live Desktop-originated session.
- Any sustained or repeated live model invocation beyond the one bounded,
  user-approved test per tool described above.

## Verification run (Phase 0)

```
npm run typecheck   # tsc --noEmit — PASS
npm run lint        # eslint src test — PASS
npm run test        # tsc build + node --test — PASS (5/5)
```

---

## Phase 1A — Codex Live Rate-Limit Detection

**Goal:** implement and verify, against the real (and, as it happens,
genuinely exhausted) Codex subscription on this machine, a usage monitor
that calls the documented `app-server` protocol directly — no model
prompts, no API keys, subscription auth only.

### What was built

- [`src/codex/appServerTransport.ts`](../src/codex/appServerTransport.ts) —
  `ProcessCodexAppServerTransport`: spawns `codex app-server --stdio`,
  performs the `initialize` → `initialized` handshake, and exposes
  `request()`/`onNotification()`/`close()` over the newline-delimited JSON
  wire format (discovered empirically — see below; it is **not**
  LSP-style `Content-Length`-framed).
- [`src/codex/usageMonitor.ts`](../src/codex/usageMonitor.ts) —
  `CodexUsageMonitor`, built against the `CodexAppServerTransport`
  interface (so it's testable without spawning a real process), plus the
  pure `classifyAccountRateLimits()` function.
- [`src/codex/formatUsage.ts`](../src/codex/formatUsage.ts) — renders a
  `CodexUsageStatus` for the CLI.
- [`src/cli.ts`](../src/cli.ts) — `agent-relay usage codex` (bin entry;
  also runnable as `node dist/src/cli.js usage codex`).

### How the protocol was reverse-engineered safely

`codex app-server --help` documents three transports (`--stdio`,
`unix://`, `ws://IP:PORT`) and a *separate*, already-running "shared local
app-server daemon" that `codex agents` talks to over
`~/.codex/app-server-control/app-server-control.sock` (not present —
no managed daemon was running) and, independently, an always-present
`~/.codex/ipc/ipc.sock` used by the Desktop app / other live tooling.
**Neither existing socket was connected to**, per the restriction against
interfering with existing Codex Desktop sessions. Instead,
`CodexUsageMonitor` spawns its **own**, isolated `codex app-server --stdio`
subprocess per call — a fresh instance scoped to our own child process,
sharing only the on-disk subscription auth, not any live session state.

Wire-format and handshake details (newline-delimited JSON; `initialize`
must complete before `initialized` is sent; `initialized` must be sent
before other requests are answered; request method name is literally
`account/rateLimits/read`) were confirmed by manually piping raw JSON-RPC
lines into `codex app-server --stdio` and inspecting the byte stream
(`xxd`) to rule out length-prefixed framing, then cross-checked against
the method/params/response shapes in `codex app-server
generate-json-schema`'s output (`ClientRequest.json` →
`"account/rateLimits/read"`, `v2/GetAccountRateLimitsResponse.json`). No
model turn was started at any point in this process.

### Live verification result (real, not mocked)

Captured on 2026-11-10 against this machine's actual, exhausted Codex
subscription, via `node dist/src/cli.js usage codex`:

```
Codex usage: EXHAUSTED
  plan: plus
  ordinaryUsageAllowed: false
  rateLimitReachedType: rate_limit_reached
  primary: 100% used, resets 2026-11-10T09:03:21.000Z (300 min window)
  secondary: 66% used, resets 2026-11-15T17:59:05.000Z (10080 min window)
```

The raw RPC result (accountId redacted) is preserved as
[`fixtures/codex-account-rate-limits-exhausted.json`](../fixtures/codex-account-rate-limits-exhausted.json).
This single round trip — `initialize` → `initialized` →
`account/rateLimits/read` — is the *entire* interaction; no `exec`, no
`resume`, no turn, zero model tokens billed. The same assertion is encoded
as a repeatable integration test
([`test/codexUsageMonitor.integration.test.ts`](../test/codexUsageMonitor.integration.test.ts))
that runs on every `npm test` without spending usage, regardless of which
of the three classifications the live account happens to be in that day.

### Capability matrix (Phase 1A)

| # | Capability | Status | Evidence |
|---|---|---|---|
| 1A.1 | `account/rateLimits/read` is reachable without a model prompt | **VERIFIED** | Live transcript above; zero `exec`/turn calls made |
| 1A.2 | Request correctly classifies a real exhausted account | **VERIFIED** | `rateLimitReachedType: "rate_limit_reached"`, `ordinaryUsageAllowed: false` → `CodexUsageMonitor` reports `"exhausted"` |
| 1A.3 | Request correctly classifies an available account | **VERIFIED** (mocked) | The real account was exhausted for this entire session, so the "available" path is unit-tested against a mocked response shaped from the same schema (`fixtures/codex-account-rate-limits-available.json`), not captured live. Flagged honestly rather than claimed as live-verified |
| 1A.4 | `account/rateLimits/updated` push notifications | **VERIFIED** (mechanism); **UNVERIFIED** (live push) | `CodexUsageMonitor.watch()` correctly wires and classifies a notification payload (unit-tested). No live update notification was *observed* arriving unprompted during this session — the subprocess is short-lived per call, and nothing changed the account's state while connected, so whether/how often the real server pushes these was not observed |
| 1A.5 | Connection failures handled without crashing | **VERIFIED** | `ProcessCodexAppServerTransport` catches spawn `ENOENT` and early process exit, surfacing them as a rejected promise that `CodexUsageMonitor.getStatus()` turns into `{classification: "unknown", error: "..."}` rather than throwing. Unit-tested via a fake transport that throws; the ENOENT path itself matches how Phase 0 confirmed `codex` is on `PATH` (so it wasn't re-tested by actually renaming the binary) |
| 1A.6 | Protocol errors / missing fields handled without crashing | **VERIFIED** | `classifyAccountRateLimits()` returns `"unknown"` with a specific `error` string for a non-object response, a response missing `rateLimits`, and the schema's own documented ambiguous case (`ordinaryUsageAllowed: null` with no `rateLimitReachedType` — see below). Unit-tested |
| 1A.7 | CLI command `agent-relay usage codex` | **VERIFIED** | `node dist/src/cli.js usage codex` (package `bin` entry is `dist/src/cli.js`, matching `tsc`'s actual output layout under `rootDir: "."`) |

### A deliberate design choice worth flagging

The response schema's own field doc for `ordinaryUsageAllowed` says: *"Null
means unavailable; clients must not infer recovery from percentages or
reset times."* `classifyAccountRateLimits()` takes that literally: if the
backend sends neither a `rateLimitReachedType` nor an explicit
`ordinaryUsageAllowed: true`, the monitor reports `"unknown"` rather than
guessing `"available"` from a low usage percentage. This trades recall for
correctness — it will report `"unknown"` in some cases a looser heuristic
would call `"available"` — on the view that a usage monitor should never
tell an orchestrator "safe to proceed" on a guess.

### Verification run (Phase 1A)

Phase 1A alone added 11 tests (16 total at that point); see the repo-wide
run at the bottom of this document for the current total.

---

## Phase 1B — Claude Subscription Usage Monitoring

**Goal:** the Claude-side counterpart to Phase 1A, behind the same kind of
interface — but only if a comparably real, zero-turn mechanism exists.

### Investigation: is there a zero-turn Claude usage endpoint?

Short answer: **no** — this is a genuine architectural difference from
Codex, not a gap in effort. What was checked, all read-only, all free:

- The full `claude --help` command and flag listing (all ~80 top-level
  commands and global flags) — grepped for every spelling of `rate`,
  `limit`, `usage`, `quota`. The only hits are the literal word "Usage:"
  in help text and unrelated words containing "rated".
- `claude auth status --help` — only `--json`/`--text` output-format
  flags; its output (confirmed in Phase 0) carries `authMethod`,
  `subscriptionType`, `email`, `orgId`/`orgName` — no usage or limit
  fields.
- `claude doctor` — installation/config health, no usage data.
- `claude mcp --help` — manages *external* MCP servers Claude connects
  to; unrelated to Claude's own usage.
- The `usage`, `usage-credits`, and `extra-usage` names that appear in
  every session's `system/init` stream-json line are **slash commands**
  (`slash_commands` array), i.e. interactive, in-session UI panels, not
  CLI subcommands or flags — there is no `claude usage` or `claude limits`
  top-level command.
- Codex's `app-server` has a dedicated, versioned `account/rateLimits/read`
  JSON-RPC method precisely because OpenAI ships that as part of the
  protocol Codex Desktop itself uses. Claude Code has no publicly
  documented equivalent local daemon/IPC surface for account metadata —
  its only documented exposure of rate-limit state is the `rate_limit_event`
  line emitted on a real turn's `--output-format stream-json` output
  (confirmed live in Phase 0).
- **Deliberately not tested:** whether a slash command like `/usage` run
  through `claude -p "/usage"` is intercepted client-side (free) or
  forwarded to the model (billed). Requirement #13 for this phase
  ("do not generate model requests solely to check usage") means this
  can't be safely probed without risking exactly the outcome it forbids,
  so it's recorded as **UNVERIFIED** rather than guessed at.

Conclusion: per the task's own fallback instruction, `ClaudeUsageMonitor`
is a **passive observer**, not an active prober. It never spawns `claude`
to run a prompt. It only classifies `rate_limit_event` lines handed to it
from a real session's stream-json output — one Agent Relay (or the person
running it) started for actual work, not to check usage.

### What was built

- [`src/usage/types.ts`](../src/usage/types.ts) — the common
  `UsageMonitor`/`UsageSnapshot` interface. `CodexUsageStatus` (Phase 1A)
  was extended with an `observedAt` field and is a structural superset of
  `UsageSnapshot`; `ClaudeUsageMonitor` implements `UsageMonitor` directly.
  Phase 1A's public API and behavior are otherwise unchanged (same method
  names, same classification values, same tests still passing).
- [`src/usage/formatWindow.ts`](../src/usage/formatWindow.ts) — the window
  renderer factored out of Phase 1A's CLI formatter so both tools' output
  share it.
- [`src/claude/usageMonitor.ts`](../src/claude/usageMonitor.ts) —
  `ClaudeUsageMonitor`:
  - `observe(parsedLine)` / `observeLine(rawLine)` feed one event at a
    time; anything that isn't a `rate_limit_event` (wrong type, invalid
    JSON, non-object) is silently ignored, never thrown.
  - `getStatus()` returns `"unknown"` with a specific reason whenever it
    has nothing trustworthy to report: the `claude` CLI isn't even on
    `PATH` (checked the same cheap way as Phase 0, `claude --version`,
    *not* a model call); nothing has been observed yet; the most recent
    observation is older than a staleness threshold (20 minutes by
    default, overridable in the constructor); or the most recent
    observation itself had an unrecognized `status` field. It never
    infers `"available"` from the mere absence of bad news.
  - `close()` is a no-op — there is no process or socket to release.
- [`src/claude/formatUsage.ts`](../src/claude/formatUsage.ts) — CLI
  rendering, reusing `formatUsageWindow`.
- [`src/cli.ts`](../src/cli.ts) — added `usage claude` and `usage all`.
  `usage claude` reads piped stdin (if any) as NDJSON and feeds each line
  to `observe()` before reporting — so
  `claude -p ... --output-format stream-json | agent-relay usage claude`
  reports on that real session's actual rate-limit state, while
  `agent-relay usage claude` run standalone correctly and honestly reports
  "unknown — never observed" (demonstrated below), since Agent Relay has
  no orchestration layer yet actually managing Claude sessions whose
  output this could passively watch.

### Live demonstration (this machine)

```
$ node dist/src/cli.js usage claude < /dev/null
Claude usage: UNKNOWN
  Could not determine usage status: no rate_limit_event has been observed yet — feed session output via observe()/observeLine()

$ cat fixtures/claude-rate-limit-ok.jsonl | node dist/src/cli.js usage claude
Claude usage: AVAILABLE
  observed at: 2026-11-10T09:09:17.615Z
  primary (5h): 17% used, resets 2026-11-10T11:50:00.000Z (unknown window length)
  secondary (7d): 2% used, resets 2026-11-16T15:00:00.000Z (unknown window length)

$ node dist/src/cli.js usage all < /dev/null
Codex usage: AVAILABLE
  plan: plus
  ...
Claude usage: UNKNOWN
  Could not determine usage status: no rate_limit_event has been observed yet — feed session output via observe()/observeLine()
```

The piped-input example reuses `fixtures/claude-rate-limit-ok.jsonl` — the
**real** `rate_limit_event` captured live in Phase 0 — so the "AVAILABLE,
17%/2%" numbers above are genuine, not fabricated for this doc; they're
just not from a *new* live call, since making one solely to demonstrate
this command would itself violate requirement #13.

### Capability matrix (Phase 1B)

| # | Capability | Status | Evidence |
|---|---|---|---|
| 1B.1 | Zero-turn Claude usage/rate-limit endpoint exists | **UNSUPPORTED** | Exhaustive `--help`/`auth status`/`doctor`/`mcp` review above; no such command, flag, or documented local IPC surface was found |
| 1B.2 | `/usage` (or similar slash command) as a free, client-side-only check via `claude -p` | **UNVERIFIED** | Deliberately not tested — would require generating a request whose cost (model-forwarded vs. intercepted) is exactly what requirement #13 forbids probing for |
| 1B.3 | Passive classification of a real `rate_limit_event` (`allowed`) | **VERIFIED** | `fixtures/claude-rate-limit-ok.jsonl` (real, Phase 0 capture) → `ClaudeUsageMonitor` reports `"available"`, `17%`/`2%` windows, matching Phase 0's own `classifyRateLimit` test |
| 1B.4 | Passive classification of an exhausted `rate_limit_event` (`rejected`) | **VERIFIED** (mocked) | `fixtures/claude-rate-limit-exhausted.jsonl` is mocked (Phase 0 already flagged this; the real account was never observed in that state) → `"exhausted"`, `100%` primary |
| 1B.5 | Malformed/irrelevant lines handled without crashing | **VERIFIED** | Invalid JSON, empty lines, non-`rate_limit_event` types, and a `rate_limit_event` with a missing `status` field are all unit-tested; none throws, and the last case is correctly distinguished from "never observed" (it *was* observed, just ambiguously) |
| 1B.6 | Missing/unavailable Claude CLI handled without crashing | **VERIFIED** | `getStatus()` checks CLI presence via an injectable function (defaults to a real `claude --version` spawn); unit-tested with a fake that reports unavailable, independent of whatever has been `observe()`d |
| 1B.7 | Stale observations never reported as current | **VERIFIED** | A 10ms staleness window plus a 50ms wait reliably reproduces staleness in-test; `getStatus()` reports `"unknown"` with the observation's age, while still surfacing the stale numbers *as context*, not as a current answer |
| 1B.8 | `ClaudeUsageMonitor` satisfies the same `UsageMonitor` interface as `CodexUsageMonitor` | **VERIFIED** | Both expose `getStatus(): Promise<UsageSnapshot>` and `close(): Promise<void>`; `CodexUsageStatus` is a structural superset of `UsageSnapshot` (added `observedAt`, non-breaking); `tsc --noEmit` is the proof — `src/usage/types.ts` compiles against both without casts |
| 1B.9 | `agent-relay usage claude` / `usage all` | **VERIFIED** | Live demonstration above; `usage all` exit code is the max of both sub-checks' exit codes |
| 1B.10 | Phase 0 and Phase 1A regressions | **VERIFIED** | All original Phase 0 (5) and Phase 1A (11) tests still pass unmodified; see the full run below |

### Verification run (Phase 0 + 1A + 1B)

```
npm run typecheck   # tsc --noEmit — PASS
npm run lint        # eslint src test — PASS
npm run test        # tsc build + node --test — PASS (25/25, including one live Codex call and zero live Claude calls)
```

---

## Phase 2A — Desktop Session Discovery and Safe Handoff

Full writeup, evidence, and the detailed capability matrix (17 items) live
in **[`docs/SESSION_DISCOVERY.md`](SESSION_DISCOVERY.md)**. Summary:

- **Session discovery** is VERIFIED for both providers: Claude via
  `claude agents --json`, Codex via the app-server's `thread/list`
  request (discovered via `generate-json-schema`, called over this
  project's own isolated `--stdio` process — never the shared daemon).
  Both were exercised live against this machine's real sessions.
- Codex's discovery path cannot capture a process id or a true
  live/idle signal (UNSUPPORTED/UNSUPPORTED-by-design — see
  SESSION_DISCOVERY.md §1 for exactly why); Claude's can, because
  `agents --json` enumerates live OS processes directly.
- **Project association** (repo root + worktree detection via `git`
  plumbing, missing-workspace detection, and a hard rule that sessions
  sharing a repo are never treated as the same task) is VERIFIED, unit-
  tested, and live-verified against a real multi-session, multi-worktree
  project on this machine.
- **The read-only handoff snapshot** is VERIFIED and deliberately never
  infers task completeness from file state — there is no such field in
  its type, enforced by a test that asserts it.
- **The disposable session continuation test — the one item in this
  phase requiring live model calls — was run with explicit user
  approval** and fully VERIFIED for both providers: a real Claude `-p`
  session and a real Codex `exec` thread each created a file, were
  "stopped" (both are non-interactive and simply exit), were resumed via
  `--resume` / `exec resume`, and each correctly recalled the exact
  filename and content from before resuming, without redoing the work.
  Bounded cost: ≈$0.32 on Claude's two turns; Codex's two turns used
  included account usage. See SESSION_DISCOVERY.md §4 for the full
  transcript.
- **Whether a Desktop-*originated* session specifically can be resumed**
  is reported UNVERIFIED, on purpose: testing it for real would mean
  either running `codex exec resume` against one of this machine's real,
  existing other projects (a modification risk this phase forbids) or
  attaching to this very conversation's own live Claude Desktop Code-tab
  session (forbidden outright). See SESSION_DISCOVERY.md §5.

### Verification run (Phase 0 + 1A + 1B + 2A)

```
npm run typecheck   # tsc --noEmit — PASS
npm run lint        # eslint src test — PASS
npm run test        # tsc build + node --test — PASS (47/47)
```

---

## Phase 2B — Cross-Provider Handoff Engine

Full writeup, evidence, and the 14-item capability matrix live in
**[`docs/HANDOFF_ENGINE.md`](HANDOFF_ENGINE.md)**. Summary:

- A full `HandoffEngine` orchestrates both directions (codex→claude,
  claude→codex) through one code path: durable persistence
  (`~/.agent-relay`, atomic write-temp-then-rename), exclusive workspace
  locks with genuine crash recovery (PID-liveness, never lock age, is
  what proves an old writer stopped), real spawn-based execution
  adapters for both CLIs (explicit argument arrays, output caps,
  timeouts, SIGTERM→SIGKILL, no bypass-permission flags), an outcome
  classifier that distinguishes rate limits / auth failures / context
  exhaustion / permission-required / crashes, and usage-gating logic
  built directly on Phase 1A/1B's monitors (`exhausted` always blocks;
  `unknown` is its own distinct decision, never silently "available").
- **Per the task's own completion criteria, this entire engine is
  verified against fake agents and disposable repositories — not real
  model calls.** All 16 required test scenarios pass this way. The real
  Codex/Claude execution adapters are genuine, runnable code (not
  stubs), and the read-only CLI commands (`handoff prepare/status`,
  `tasks`, `task inspect`) were smoke-tested against this machine's real
  discovered sessions — but `handoff execute` was never run against the
  real CLIs in this phase.
- **Real cross-provider execution is reported UNVERIFIED**, exactly as
  instructed, until a live run is separately authorized the same way
  Phase 2A's disposable continuation test was.

### Verification run (Phase 0 + 1A + 1B + 2A + 2B)

```
npm run typecheck   # tsc --noEmit — PASS
npm run lint        # eslint src test — PASS
npm run build       # tsc — PASS
npm run test        # tsc build + node --test — PASS (65/65)
```

---

## Phase 2C — Live Cross-Provider Handoff Verification

Full writeup, the hardening details, and the 13-item capability matrix
live in [`docs/HANDOFF_ENGINE.md`](HANDOFF_ENGINE.md) (appended to the
Phase 2B section). Summary:

- **Workspace-ownership logic was hardened** in six concrete ways: the
  source session is no longer excluded from activity checks (so a still-
  active source is actually caught); an "unknown" activity signal is now
  treated as unsafe for automatic takeover, not as "no news is good
  news" — which, honestly stated, means **any workspace with Codex
  history requires `--force-lock` for an automatic takeover**, since
  Codex's own discovery interface cannot prove a thread has stopped;
  `--force-lock` stays an explicit-only override; lock age was never
  (and still isn't) sufficient proof a writer stopped; lock keys now
  resolve through `realpath` so symlinked workspace aliases collide
  correctly with their real target; and fresh lock acquisition is now
  atomic at the filesystem level (`O_EXCL`), closing a real
  two-controllers-race window Phase 2B had. Timed-out child processes
  are now killed as a whole POSIX process group, so a misbehaving
  descendant that ignores SIGTERM doesn't outlive the engine's own
  cleanup.
- **Both real handoff directions were run live and succeeded**, with
  explicit user authorization obtained first (after everything
  non-model — repos, baselines, handoff packages — was prepared and
  confirmed). In disposable TypeScript repos: a real `claude -p` call
  correctly continued (not restarted) an unfinished `reverseWords`
  function while leaving the already-correct `capitalize` untouched; a
  real `codex exec` call did the same for `unique`/`sum`. Both passed
  their configured `node --test` validation command, neither made a new
  git commit, and both repos' untracked notes files survived untouched.
  `handoff status` for both shows accurate, persisted history including
  the new ownership-verification evidence.
- A fixture-based regression test for the outcome classifier (added for
  this phase's "real adapter output parsing" requirement) caught a
  genuine bug: Claude's rate-limit classifier was matching its regex
  against raw event JSON that includes field names like
  `rate_limit_event`, so it misclassified *every* Claude run as rate-
  limited. Fixed before the live run above — exactly the kind of mistake
  recorded fixtures catch that hand-written fakes don't.

### Verification run (Phase 0 + 1A + 1B + 2A + 2B + 2C)

```
npm run typecheck   # tsc --noEmit — PASS
npm run lint        # eslint src test — PASS
npm run build       # tsc — PASS
npm run test        # tsc build + node --test — PASS (85/85)
```

---

## Phase 3A — Automatic Handoff Orchestration

Full writeup and the 16-item capability matrix live in
[`docs/AUTOMATIC_HANDOFF.md`](AUTOMATIC_HANDOFF.md). Summary:

- A new `AutomaticHandoffCoordinator` supervises a task through an
  11-state durable machine (`queued` → ... → `completed`/`paused_*`/
  `failed`), automatically switching providers on failure or exhaustion
  by calling Phase 2B/2C's `HandoffEngine` exactly as it already is —
  nothing about the handoff mechanism itself changed.
- **The ownership model is now explicit and three-valued**
  (`relay_managed` / `external_idle_confirmed` / `external_unknown`),
  and automatic switching is permitted only from the first two —
  `--force-lock` is never set by this coordinator, ever, by
  construction. Lock age, file inactivity, and a provider being
  exhausted are all explicitly *not* accepted as proof a desktop agent
  has stopped — only Phase 2C's own PID-liveness and activity
  classification are.
- **Provider selection reuses Phase 1A/1B's usage monitors unchanged**:
  Codex via the real, zero-cost `account/rateLimits/read`; Claude
  passively, with the coordinator keeping one `ClaudeUsageMonitor`
  instance alive for its run and feeding it every real Claude
  execution's own output — no prompt is ever sent solely to check
  availability. "Unknown" availability is a distinct, opt-in, bounded
  policy, never silently treated as "available."
- Cooldowns prefer a provider's own reported reset time over a guess;
  bounded exponential backoff only applies when none is known.
  Maximum handoffs/attempts/runtime are enforced, and auth/permission
  failures stop automatic retries outright.
- **Per the task's own restriction, no live coding-agent turn was run
  in this phase.** All 16 required test scenarios — both exhaustion
  directions, both-exhausted pausing, unknown availability (both
  policy settings), mid-task crashes, blocked handoffs (busy and
  unknown activity), destination exhaustion, multi-leg bouncing,
  coordinator-restart recovery, validation failure, retry/handoff
  limits, no-duplicate-execution, no-automatic-force-lock, no-API-key
  authentication, and preservation of existing work — pass against
  fake providers and disposable repositories, exactly as the task's
  completion criteria specify.

### Verification run (Phase 0 + 1A + 1B + 2A + 2B + 2C + 3A)

```
npm run typecheck   # tsc --noEmit — PASS
npm run lint        # eslint src test — PASS
npm run build       # tsc — PASS
npm run test        # tsc build + node --test — PASS (101/101)
```

---

## Phase 3B — Desktop Session Integration and Safe Ownership Transfer

Full writeup and the 17-item capability matrix live in
[`docs/DESKTOP_INTEGRATION.md`](DESKTOP_INTEGRATION.md). Summary:

- A new `DesktopSessionRecord`/`DesktopRegistry` (`src/desktop/`) tracks
  desktop-originated sessions durably, never merging two sessions that
  merely share a `repoRoot`. A **new, separate** 7-state ownership model
  (`external_unmanaged` / `external_active` / `external_unknown` /
  `handoff_requested` / `relinquished` / `relay_owned` / `released`) governs
  only this new path — Phase 3A's existing 3-state `OwnershipState` for the
  supervised leg-to-leg bounce is untouched, by design, per the requirement
  to preserve all Phase 0–3A functionality.
- **A past authorization is never standing permission.** Every ownership
  check re-derives its answer from the current workspace-lock and activity
  signals only; a prior `handoff_requested` call doesn't carry forward as
  proof of safety on a later one.
- **Codex Desktop integration added no new mechanism** — Phase 0/2A already
  established that `thread/list` can't prove liveness and
  `account/rateLimits/read` is the already-built, account-level signal;
  this phase reuses both unchanged and touches no undocumented socket.
- **Claude Desktop integration adds one new, passive piece**: a hook-event
  receiver (`agent-relay desktop hook-event`) that parses Claude Code's
  documented hook JSON and records it as evidence — built, but **not wired
  into the user's real `~/.claude/settings.json`**, since that's a
  standing-configuration change requiring separate explicit permission.
- **Desktop-to-CLI continuation reuses `HandoffEngine`/`createHandoffRecord`
  exactly as `handoff execute`/`handoff prepare` already do — no second
  execution engine was built**, per the task's own restriction.
- **Per the task's own completion criteria, fully automatic desktop handoff
  from a real Desktop GUI session is not claimed as demonstrated
  end-to-end.** No tool in this environment can open or drive an actual
  Codex Desktop or Claude Desktop GUI window; every pipeline step is
  verified against fakes (30 new tests), plus the one step — read-only
  discovery of a live Desktop session — already safely demonstrated live in
  Phase 2A. A live model-call demonstration of the continuation step itself
  would need the same kind of separate, explicit authorization every live
  run in this project has required, and wasn't requested in this phase.
- Reviewed every item in the coordinator-hardening list against
  `src/auto/coordinator.ts`: six of seven were already satisfied by existing,
  unmodified code (so `coordinator.ts` itself has zero changes this phase);
  one — a human manually editing files in a desktop app while a Relay
  worker is separately active in the same workspace — is honestly documented
  as an unclosed gap rather than built around, since closing it would need
  exactly the kind of second execution path/polling watchdog the task
  restricts.

### Verification run (Phase 0 + 1A + 1B + 2A + 2B + 2C + 3A + 3B)

```
npm run typecheck   # tsc --noEmit — PASS
npm run lint        # eslint src test — PASS
npm run build       # tsc — PASS
npm run test        # tsc build + node --test — PASS (131/131)
```

---

## Phase 4 — Persistent macOS Background Daemon

Full writeup and the 28-item capability matrix live in
[`docs/DAEMON.md`](DAEMON.md). Summary:

- A new `src/daemon/` module turns the existing, unchanged
  `AutomaticHandoffCoordinator`/`HandoffEngine` into a persistent
  background service: a Unix-socket control protocol (`src/daemon/
  protocol.ts`/`socketServer.ts`/`client.ts`, user-only `0600`
  permissions, no TCP listener), a non-blocking task scheduler
  (`src/daemon/scheduler.ts`), crash recovery (`src/daemon/recovery.ts`),
  desktop-session polling reusing Phase 3B's `DesktopRegistry` unchanged
  (`src/daemon/desktopMonitor.ts`), a config file with no credential field
  anywhere in its type (`src/daemon/config.ts`), structured/redacted JSONL
  logs (`src/daemon/log.ts`), and launchd plist generation (`src/daemon/
  launchd.ts`). **Per the task's own restriction, no new handoff engine was
  built** — the daemon only hosts the existing one persistently.
- **The coordinator's only change is a behavior-preserving decomposition**:
  `start()`/`resume()` are now `prepareStart()`/`prepareResume()` (the
  durable "accept and record" half) + `continueFrom()` (the existing
  per-leg loop) — `start()`/`resume()` themselves still do both, so every
  one of the 137 pre-Phase-4 tests passes unmodified, confirming this adds
  no behavior change for any existing caller.
- **Real mid-execution cancellation**: a new, optional `AbortSignal`
  threads from the daemon's scheduler through
  `AutomaticHandoffCoordinator` → `HandoffEngine` → the execution
  adapter → `spawnRun`, which reuses its **existing** process-group
  kill/timeout machinery (Phase 2C) on abort — a new `"cancelled"`
  `ExecutionOutcomeKind`, checked ahead of crash/timeout classification,
  means a daemon-requested pause/stop is never misreported as either. A
  new terminal `AutoState`, `"stopped"`, is reached only when a live
  execution was genuinely interrupted with reason `"stop"`; pausing
  mid-execution reuses the existing `"paused_approval"` state. A direct
  `coordinator.stop()`/`pause()` call with nothing in flight is completely
  unchanged from Phase 3A — the new, more precise outcomes only apply to
  the genuinely-interrupted case.
- **Crash recovery never assumes an old PID still belongs to the original
  worker** — it reads the real lock record and checks real process
  liveness (the same `isPidAlive` Phase 2C already built), refusing to
  resume anything whose lock is held by a genuinely live process, and
  logging every decision (resumed/left-alone/skipped-corrupted) as an
  audit trail. A corrupted task-state file is skipped, never fatal to
  startup.
- **Per the task's own restrictions**: `daemon install`/`uninstall` only
  write/remove the plist file — neither this phase nor any command in it
  calls `launchctl load`/`bootstrap`/`bootout` itself, and nothing wires a
  Claude Code hook into the user's real `~/.claude/settings.json`. No live
  coding-agent turn was run; no commit was made.
- 32 new tests, all against fakes and disposable state/socket directories
  (`mkdtemp`) — no real launchd write, no real model call.

### Verification run (Phase 0 + 1A + 1B + 2A + 2B + 2C + 3A + 3B + 4)

```
npm run typecheck   # tsc --noEmit — PASS
npm run lint        # eslint src test — PASS
npm run build       # tsc — PASS
npm run test        # tsc build + node --test — PASS (169/169)
```

---

## Phase 5 — Setup & Integration Management

Full writeup and the 13-item capability matrix live in
[`docs/SETUP.md`](SETUP.md). Summary:

- Replaces Phase 3B's manual "copy this JSON snippet into your settings
  file" instruction with a proper subsystem: `agent-relay setup` detects
  installed agents, prints every proposed config change, and only
  applies them after explicit approval (`--yes` or an interactive
  prompt — never inferred from a piped stdin); `agent-relay integrations
  status/repair/uninstall` manage the result afterward.
- A new `src/setup/adapter.ts` interface (`detect`/`plan`/`apply`/
  `status`/`repair`/`uninstall`) is implemented twice: `ClaudeCodeAdapter`
  (a real `~/.claude/settings.json` `Stop`-hook integration, with
  backups, preservation of every unrelated setting, idempotency, and
  absolute-path commands — all verified directly) and `CodexAdapter`
  (honestly `not_applicable`, since Codex has no documented hook/config
  integration point, consistent with every prior phase's findings).
- **Per the user's explicit instruction, nothing in this phase touched a
  real Claude/Codex configuration file, and nothing was committed** —
  every test runs against a `mkdtemp()`-created disposable directory.
- A dedicated test confirms a `Stop` hook event is recorded as evidence
  only — it never changes a session's ownership, activity, or any
  usage-exhaustion state.
- NPM packaging itself remains explicitly deferred to a later phase, per
  the user's own instruction.
- 24 new tests, all against fakes/disposable fixture directories.

### Verification run (Phase 0 + 1A + 1B + 2A + 2B + 2C + 3A + 3B + 4 + 5)

```
npm run typecheck   # tsc --noEmit — PASS
npm run lint        # eslint src test — PASS
npm run build       # tsc — PASS
npm run test        # tsc build + node --test — PASS (193/193)
```

---

## Phase 6 — Automated Setup & NPM Packaging

Full writeups live in [`docs/INSTALLATION.md`](INSTALLATION.md),
[`docs/INTEGRATIONS.md`](INTEGRATIONS.md),
[`docs/UNINSTALL.md`](UNINSTALL.md), [`docs/RELEASE.md`](RELEASE.md),
and a new section appended to [`docs/SETUP.md`](SETUP.md). Summary:

- **Packaging**: `package.json` gained `files`/`exports`; `npm pack`
  contents were verified for real (only `dist/src` + `package.json` ship
  — no `test/`, no `node_modules`, no `.git`). A real global install
  from that tarball into an isolated `--prefix` directory was verified,
  including running the installed binary from a `cwd` outside the
  source repository.
- **Setup rounded out**: `agent-relay setup`/`doctor` now open with
  OS/runtime detection and a subscription-auth check that never reads a
  credential file (`src/setup/environment.ts`, `src/setup/authCheck.ts`
  — reusing Phase 0's own already-proven probes). The background daemon
  is now one more approved `setup` change
  (`src/setup/daemonAdapter.ts`), stopping at writing the plist file —
  never calling `launchctl` on its own.
- **Claude Code integration generalized**: manages `Stop` *and*
  `SessionEnd` hooks (not just `Stop`), each with a bounded timeout so a
  stuck receiver can never block a real session; `apply()`/`uninstall()`
  now also preserve the settings file's original permission mode.
- **Real launchd activation, never self-invoked**: `agent-relay daemon
  activate`/`deactivate` (idempotent, injectable `launchctl` runner) plus
  a single-lifecycle-owner refusal in `daemon start` when launchd already
  has the service loaded. **No command in any phase of this project has
  ever invoked the real `launchctl` against this machine's actual
  launchd** — every test injects a fake runner.
- **Two genuine concurrency bugs found and fixed**: (1) two concurrent
  `setup` runs could duplicate a hook — fixed with a small file lock
  reusing `WorkspaceLockManager`'s own atomic-create-plus-dead-PID-reclaim
  pattern (`src/setup/fileLock.ts`); (2) two daemons racing to start
  against the same state directory had a real TOCTOU gap between the
  friendly pre-check and the actual socket bind — fixed by making
  `listen()`'s own `EADDRINUSE` the atomic guard, with the pre-check kept
  only for a clearer error message.
- **A third, more interesting bug was found by the new end-to-end
  integration test itself**: if a crash happened in the narrow window
  after `HandoffEngine.executeHandoff` persisted `destinationProvider`
  (right after acquiring the workspace lock) but before it ever recorded
  an attempt, recovery's own follow-on-leg logic
  (`src/auto/followOnHandoff.ts`) checked the wrong field
  (`destinationProvider` instead of whether an attempt had actually been
  recorded) and tried to build a same-provider handoff, which
  `HandoffEngine` correctly refused — surfacing as a silently-swallowed
  exception (a second bug: nothing logged a `continueFrom` rejection at
  all, fixed in `src/daemon/scheduler.ts`). Both are fixed, and the fix
  is covered by the full pre-existing test suite passing unmodified plus
  the new integration test passing repeatably.
- **`agent-relay config show`/`config validate`/`doctor`** — the
  aggregate health check requirement #6 asks for.
- **A real, end-to-end integration-lifecycle test**
  (`test/integrationLifecycle.test.ts`) drives the actual globally-
  installed binary, from a real `npm pack` tarball, through the complete
  lifecycle: install → `setup --yes` (with hook/permission/preservation
  verification against a pre-seeded fixture) → daemon start → submit a
  task → the submitting CLI process exits → the daemon continues it →
  pause → resume → a simulated crash (`SIGKILL`) → daemon restart →
  verified recovery with no duplicate execution → `integrations
  status`/`doctor` → `integrations uninstall` → verified only this
  tool's own entries were removed → cleanup of every temporary process
  and file. The real `codex`/`claude` CLIs are never invoked: `claude` is
  replaced on `PATH` by a small scripted stand-in (the same role
  `FakeExecutionAdapter` plays at the library level everywhere else in
  this suite, just reachable by a real spawned process), and a real
  `codex` binary, if present on the machine, is deliberately *shadowed*
  by a fake one rather than relied upon to be absent — so this test can
  never accidentally make a real, billable or rate-limited call.
- **Per the user's explicit instruction**: no real `launchctl` call, no
  write to this machine's actual `~/.claude/settings.json`, no npm
  publication, and no git commit anywhere in this phase. Automatic
  handoff from an independently running desktop session remains
  explicitly stated as not yet fully verified (`docs/INTEGRATIONS.md`).
- 24 new tests (environment, daemon adapter, launchd activation, config
  validation, and the one end-to-end integration test), plus two
  real production-code fixes (not test-only workarounds) found by
  exercising the system for real for the first time.

### Verification run (Phase 0 + 1A + 1B + 2A + 2B + 2C + 3A + 3B + 4 + 5 + 6)

```
npm run typecheck     # tsc --noEmit — PASS
npm run lint          # eslint src test — PASS
npm run build         # tsc — PASS
npm run test          # tsc build + node --test — PASS (217/217: 193 pre-existing + 24 new)
npm pack --dry-run    # confirms tarball contents: dist/src + package.json only
```

217 tests total: the 193 from Phase 5, unmodified, plus 24 new —
`test/setupEnvironment.test.ts`, `test/setupDaemonAdapter.test.ts`,
`test/launchdActivation.test.ts`, `test/daemonConfigValidate.test.ts`,
`test/integrationLifecycle.test.ts`, and two more added directly to
`test/setupClaudeAdapter.test.ts` (permission preservation, the
concurrency-lock race). The integration test was run repeatedly (10+
consecutive passes) to confirm it's stable, not a one-off — its first
few runs surfaced both the real recovery bug above and a timing race in
the test's own ordering (removing a test-controlled sleep gate *after*
confirming a daemon restart, when crash recovery's background retry can
reach the fake CLI first) — the second was a test bug, not fixed by
touching any production code.

## Phase 7 — Multi-Agent Support (beyond Codex/Claude)

Full writeup lives in [`docs/MULTI_AGENT.md`](MULTI_AGENT.md). Summary:

- **`SessionProvider` generalized from a hardcoded pair to a 3-literal
  union** (`"codex" | "claude" | "copilot"`), with the real behavioral
  change isolated to one new function: `candidateProviders(current,
  enabled, pinned)` in `src/auto/providerSelection.ts`, which
  `selectAlternativeProvider` now walks in order instead of assuming
  exactly one alternative exists. Proven genuinely N-way (not
  Copilot-specific) with a fourth *fake* provider in
  `test/providerSelectionGeneralized.test.ts`; the 2-provider case is
  unchanged, confirmed by the full pre-existing suite passing
  unmodified.
- **GitHub Copilot CLI wired up as a real third provider** — execution
  adapter (`src/execution/copilotExecutionAdapter.ts`), passive usage
  monitor (`src/copilot/usageMonitor.ts`), and setup/integration adapter
  (`src/setup/copilotAdapter.ts`), all grounded in this machine's real
  `copilot --help`/`sessions --help`/`login --help`/`help billing`
  output (read-only, no prompt sent — v1.0.109). `enabledProviders`
  defaults to `["codex", "claude"]` everywhere, so Copilot is opt-in for
  every existing install, never silently activated.
- **Two latent routing bugs found and fixed before they could ship**:
  both `HandoffEngine`'s and `AutomaticHandoffCoordinator`'s
  `defaultGetUsageStatus` used an `if (provider === "claude") ... else
  codex` pattern that would have silently misrouted any new provider's
  usage checks to the wrong monitor the moment `"copilot"` became a
  valid `SessionProvider` value. Fixed with explicit per-provider
  branches before any such code could ship.
- **Session discovery is honestly `UNSUPPORTED` for Copilot**: `copilot
  sessions` has only an `import` subcommand, no `list`/`--json`
  enumeration — `discoverAllSessions` reports this as an explicit error
  rather than silently returning nothing. Copilot can still be a
  handoff *destination*.
- **Still `UNVERIFIED`**: the exact JSON event shape `copilot
  --output-format json` emits for a real run. `interpretCopilotRun`
  classifies best-effort today; confirming the real shape needs one
  bounded live `copilot -p` prompt, which is a separate, explicit ask
  not made during this phase.
- **Windsurf/Devin, Kiro, and Kilo Code investigated and explicitly not
  built**: Windsurf's billing reportedly moved to credit-based ACUs
  under Cognition and needs its own feasibility check; Kiro's
  documented headless auth is an API key, conflicting with this
  project's no-API-keys rule; Kilo Code is BYOK/metered. All three, and
  what would need to be true for each to become eligible, are recorded
  in `docs/MULTI_AGENT.md`.
- 24 new tests — `test/providerSelectionGeneralized.test.ts`,
  `test/copilotUsageMonitor.test.ts`, `test/setupCopilotAdapter.test.ts`,
  one new case in `test/daemonConfigValidate.test.ts`, and one field
  added to an existing hand-constructed fixture in
  `test/autoCoordinatorRestart.test.ts` — no real `copilot -p` prompt
  sent in any of them.

### Verification run (Phase 0 + 1A + 1B + 2A + 2B + 2C + 3A + 3B + 4 + 5 + 6 + 7)

```
npm run typecheck     # tsc --noEmit — PASS
npm run lint          # eslint src test — PASS
npm run build         # tsc — PASS
npm run test          # tsc build + node --test — PASS (241/241: 217 pre-existing + 24 new)
```

241 tests total: the 217 from Phase 6, unmodified, plus 24 new proving
the N-provider generalization and the Copilot adapters, none of which
ever spawns a real `copilot -p` prompt.

## Phase 8 — Live App Handoff

Full writeup lives in [`docs/LIVE_HANDOFF.md`](LIVE_HANDOFF.md). Summary:

- **A user-reported gap became a new, additive command**: `handoff
  execute` is headless by design (it spawns a non-interactive process,
  captures the result, nothing ever appears in an app), which surprised a
  user expecting a prepared handoff to show up in Claude Desktop. Rather
  than change `execute`'s behavior, this phase adds `agent-relay handoff
  open <handoff-id> --to <claude|codex>` — a separate command that opens a
  **visible, human-driven** session in the destination's own app.
- **Grounded in this machine's real `claude --help`/`codex --help`/
  `copilot --help`** (read-only, nothing executed): Claude's `--desktop`
  flag genuinely opens the Desktop app on a resumed or brand-new session;
  Codex has `queue --thread`/`app` but no single primitive that both seeds
  a message and opens the app for a brand-new thread; Copilot has no
  session-targeted app-opening or message-queuing primitive at all.
- **Copilot is honestly left out**: no `LiveOpenAdapter` was built for it
  — `handoff open --to copilot` is refused by `openHandoffLive` itself
  (no adapter registered), the same refusal path any future provider
  without one would hit, not a special-cased string.
- **New safety model, not a variant of `execute`'s**: the same workspace
  activity check `execute` already runs still gates every open, but no
  workspace lock is held — a live app session's completion is
  human-driven and indefinite, so holding a lock for its duration would
  block every other guarded operation forever. On success, the workspace
  is registered via `DesktopRegistry.registerFromHandoff()` (one new
  method; Phase 3B's registry otherwise unchanged) with
  `ownershipStatus: "external_active"`, reusing `agent-relay desktop
  sessions`/`desktop inspect` as the existing way to see it — no new
  inspection command. `HandoffStatus` gained one new value,
  `"opened_live"`, confirmed safe to add (never matched in an exhaustive
  switch anywhere, and `AutomaticHandoffCoordinator` never calls this
  path).
- **`src/execution/launchDetached.ts`** is a new, deliberately separate
  counterpart to `spawnRun.ts` for GUI-launching commands — fire-and-
  forget, no timeout, no output capture, no process-group kill, since
  there's nothing to wait for once a window opens. It does wait one short
  grace period for Node's own async spawn-error event, so a missing CLI
  binary is never reported as "launched."
- **Live-verified, same day, by the user**: `claude --desktop` flatly
  refuses a prompt argument (`--desktop doesn't take a prompt yet. Run
  \`claude --desktop\`, then type it in the app.`) — the Desktop app was
  already installed and running, so that wasn't the blocker. Fixed:
  `ClaudeLiveOpenAdapter` never sends the instruction as an argument,
  `LiveOpenResult` gained a `seeded` field, and `handoff open` now prints
  the instruction text for the person to paste in by hand whenever
  nothing could seed it (true for every Claude open, and for a Codex
  open with no existing thread). A second live round found the deeper
  cause: `--desktop` refuses to run at all with redirected stdio
  (`--desktop opens the Claude Desktop app and can't run
  non-interactively ... or redirected output`) — `launchDetached` was
  piping/ignoring it to capture errors, which triggered the refusal.
  Fixed by switching to `stdio: "inherit"`. **Confirmed working
  end-to-end on a real repo**: the Claude Desktop window genuinely opens,
  on its own fresh worktree, with the printed instruction pasted in
  manually as designed. Still `UNVERIFIED`: whether `codex app <path>`
  auto-attaches to an existing thread for that path, and whether `codex
  queue` requires the shared app-server daemon already running.
- 12 new tests — `test/launchDetached.test.ts`,
  `test/claudeLiveOpenAdapter.test.ts`, `test/codexLiveOpenAdapter.test.ts`,
  `test/handoffOpen.test.ts` — all against fakes/injected functions; no
  real `claude`/`codex`/`copilot` app is ever opened by the test suite.

### Verification run (Phase 0 + 1A + 1B + 2A + 2B + 2C + 3A + 3B + 4 + 5 + 6 + 7 + 8)

```
npm run typecheck     # tsc --noEmit — PASS
npm run lint          # eslint src test — PASS
npm run build         # tsc — PASS
npm run test          # tsc build + node --test — PASS (253/253: 241 pre-existing + 12 new)
```

253 tests total: the 241 from Phase 7, unmodified, plus 12 new proving
the live-open adapters and `openHandoffLive`'s safety model, none of
which ever opens a real app or spawns a real `claude`/`codex`/`copilot`
process.

## Phase 9 — Provider-Choice Notifications for Automatic Handoff

Full writeup lives in
[`docs/PROVIDER_CHOICE_NOTIFICATIONS.md`](PROVIDER_CHOICE_NOTIFICATIONS.md).
Summary:

- **A real, deliberate, breaking change to this project's flagship
  feature's default behavior**, driven directly by a user request:
  `selectAndAdvance()` (`src/auto/coordinator.ts`) no longer silently
  auto-picks the next enabled provider — it always pauses
  (`paused_approval`, new `pendingProviderChoice` field) and waits for an
  explicit `agent-relay auto resume <task-id> --pin <provider>`, every
  leg, not just when every candidate is exhausted. A standing `auto start
  --pin <provider>` is unaffected — still never pauses to ask, exactly as
  before.
- **A one-time resume pin is consumed, not sticky**: a real design gap
  was caught before shipping — if a `resume({ pin })` choice stayed set
  forever, the *next* exhaustion would be stuck pinned to whatever just
  failed (since it would now equal `currentProvider`). Fixed with a new
  `pinnedProviderSticky` field distinguishing a standing `auto start
  --pin` (never cleared) from a one-time resume pin (cleared the moment
  it's consumed).
- **A real OS notification, daemon-only, via `terminal-notifier`** (a
  new, separately-installed macOS CLI — not an npm dependency, not
  installed on this machine; macOS's own `osascript -e 'display
  notification'` cannot show custom action buttons at all). Detected the
  same honest way `claude`/`codex`/`copilot` already are — absence
  degrades to no popup, never a failure. The exact `-actions`/`-json`
  response shape is `UNVERIFIED` pending `brew install terminal-notifier`
  and a live test.
- **A second re-entrancy bug was caught and fixed during testing, not
  after shipping**: the scheduler's own notification side effects
  (`TaskScheduler.handleSettled()`) were chained in a way that raced
  against `inFlight` cleanup twice — first, a notification's own latency
  could delay `requestStop()`/`requestPause()` seeing the task as no
  longer running; second, and more seriously, a recursive
  `this.resume()` call (made when a notification actually picks a
  provider) could see the task as "still in flight" and silently no-op
  instead of resuming it, because the cleanup hadn't run yet. Both fixed
  by moving `inFlight.delete()` to run synchronously, first, in both the
  fulfilled and rejected branches, with notification logic kicked off
  only after.
- **Seeding still only ever works via a real headless turn** (Phase 8's
  finding, reused unchanged): once a destination is picked, the existing
  `handOffAndAdvance()`/`HandoffEngine.executeHandoff()` path runs it for
  real; `handoff open` (Phase 8) stays the separate, manual step to
  actually view it, per the choice made for this phase (no auto-opening).
- **Large, deliberate test-suite rewrite, not an additive one**: every
  pre-existing scenario across `test/autoCoordinator.test.ts`,
  `test/autoCoordinatorCancellation.test.ts`, `test/daemonCancellation.test.ts`,
  `test/daemonRecovery.test.ts`, and `test/integrationLifecycle.test.ts`
  (the real end-to-end daemon test) that used to complete automatically
  within one `start()` call was restructured to the new
  pause-then-`resume({ pin })` shape — none of their underlying
  guarantees (crash recovery, cancellation, no-duplicate-execution,
  workspace preservation) changed, confirmed by running each rewritten
  scenario individually against the new behavior before the full suite.
- 14 new tests — `test/providerChoicePause.test.ts`,
  `test/terminalNotifier.test.ts`, `test/schedulerNotifications.test.ts`
  — plus the rewritten files above, all against fakes/injected functions;
  no real `terminal-notifier` process is ever spawned by the suite.

### Verification run (Phase 0 through 9)

```
npm run typecheck     # tsc --noEmit — PASS
npm run lint          # eslint src test — PASS
npm run build         # tsc — PASS
npm run test          # tsc build + node --test — PASS (267/267)
```

267 tests total: 253 from Phase 8 (several rewritten in place, none
dropped) plus 14 new proving the provider-choice pause, the one-time-pin
consumption, and the notification wiring.
