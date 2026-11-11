# Phase 5 — Setup & Integration Management

Goal: replace the manual "copy this JSON snippet into your settings file"
instruction Phase 3B documented (never applied) with a proper
`agent-relay setup`/`integrations` subsystem — automatic detection,
user-approved application, backups, idempotency, status/repair/uninstall,
and an extensible adapter interface for future coding agents. Per the
user's explicit instruction, **nothing in this phase was run against a
real Claude or Codex configuration** — every demonstration below is
against a disposable fixture directory, and nothing was committed.

## 1–2. Setup command and automatic configuration, gated on approval

`src/cli.ts`'s `setup` command (`src/setup/run.ts`'s `planSetup()`/
`applySetup()` underneath):

1. Runs every registered adapter's `detect()`, then (only for agents
   actually detected as installed) `plan()` — entirely read-only.
2. Prints every proposed change as a human-readable description — never
   raw JSON — before anything is written.
3. Requires explicit approval: `--yes` (non-interactive/scriptable) or an
   interactive `y/n` prompt when stdin is a real TTY. **A non-interactive,
   non-`--yes` invocation never guesses approval from a piped stdin** —
   `confirmInteractively()` returns `false` outright whenever
   `process.stdin.isTTY !== true`.
4. On approval, calls each adapter with real changes' `apply()` in turn.
5. **In this development session, `setup`/`integrations ...` were only
   ever invoked in tests against disposable fixture directories — never
   against this machine's real `~/.claude`/`~/.codex`.**

## 3. Integration adapter interface — `src/setup/adapter.ts`

```ts
interface IntegrationAdapter {
  readonly id: string;
  detect(): Promise<DetectionResult>;
  plan(): Promise<IntegrationChange[]>;   // read-only diff
  apply(): Promise<ApplyResult>;          // backs up, idempotent
  status(): Promise<IntegrationStatus>;   // installed/missing/broken/not_applicable
  repair(): Promise<ApplyResult>;         // re-applies only the gap
  uninstall(): Promise<ApplyResult>;      // removes only our own entries
}
```

Two implementations ship with this phase (requirement #10's
extensibility is the interface itself — a third agent is just a third
class implementing it, nothing in `setup`/`integrations` hardcodes which
adapters exist beyond the list `src/setup/run.ts`'s `defaultAdapters()`
returns):

### Claude Code — `src/setup/claudeCodeAdapter.ts`

- Detection reuses the same zero-token `claude --version` check
  Phase 0/1B already established (`checkClaudeCliAvailable`, factored out
  so this adapter doesn't need to depend on `src/claude/usageMonitor.ts`
  for an unrelated reason).
- Config file: `~/.claude/settings.json` by default, fully
  constructor-injectable — every test in this phase uses a disposable
  path.
- **Preservation (requirement #3)**: `plan()`/`apply()` only ever add a
  new `hooks.Stop[]` entry to a *deep clone* of the parsed file — every
  other key, every other hook event, every other `Stop` entry passes
  through completely untouched. Verified directly: a fixture file with
  an unrelated `Stop` hook, a `SessionStart` hook, `permissions`, and a
  `model` setting survives byte-for-byte except for the one addition.
- **A corrupted existing file is refused, never guessed past** — if the
  file exists but isn't valid JSON, `plan()`/`apply()` throw rather than
  silently treating it as `{}` and overwriting real content with an
  empty-based merge. The file on disk is confirmed untouched in this
  case.
- **Absolute paths (requirement #5)**: the generated hook command is
  `"<node path>" "<cli.js path>" desktop hook-event` — `process.execPath`
  and the resolved `cli.js` path, the exact same resolution `daemon
  install`'s plist generation already uses — never a bare `agent-relay`
  that depends on `PATH` at hook-invocation time.
- **Backups (requirement #4)**: any `apply()`/`uninstall()` call that's
  about to modify an *existing* file copies it first to
  `<path>.bak-<ISO timestamp>` — verified to match the original exactly,
  byte for byte. A file that didn't exist yet has nothing to back up
  (`backupPaths` is empty), which is correct, not a gap.
- **Idempotency (requirement #6)**: `plan()`/`apply()` recognize an
  already-present entry by a stable marker (`desktop hook-event`, the
  literal subcommand every generated command ends with — deliberately
  *not* a longer phrase like `"agent-relay desktop hook-event"`, since
  the real generated string is `"<path containing the word
  agent-relay>" "<cli path>" desktop hook-event` and those two halves are
  never contiguous in a quoted, absolute-path command). Calling `apply()`
  twice writes the hook exactly once; `plan()` after that reports nothing
  left to do.
- `status()` re-reads the file fresh and distinguishes `missing` (no
  matching entry), `installed` (present, and the referenced executable
  still exists on disk), and `broken` (present, but the executable it
  points at is gone) — verified by actually deleting the fake executable
  between checks.
- `uninstall()` removes only `Stop` entries whose *every* inner hook
  command carries the marker — an entry that happens to also run
  something else alongside is left alone; an unrelated `Stop` hook
  present before `agent-relay` ever touched the file survives untouched
  (verified directly).

### Codex — `src/setup/codexAdapter.ts`

Codex has no documented hook or config-file integration point — Phase
0/2A/3B already established this, and this phase does not reopen that
investigation or invent an undocumented one. `plan()` always returns
`[]`; `status()` reports `not_applicable` rather than fabricating a fake
"installed" state. Codex still appears in `setup`/`integrations status`
honestly, as "detected, nothing to configure" — not silently omitted
from the extensible adapter list.

## 7. `agent-relay integrations status|repair|uninstall`

All three (`src/setup/run.ts`'s `statusAll()`/`repairAll()`/
`uninstallAll()`) iterate every registered adapter independently:

- `status`: `detect()` + `status()` per adapter, printed as a table.
- `repair`: calls `repair()` **only** for an adapter whose `status()`
  reports something `missing`/`broken` — an already-fully-installed
  adapter is left alone, never blindly re-applied (verified directly:
  its `apply()`/`repair()` call count stays zero).
- `uninstall`: calls every adapter's own `uninstall()` — removing only
  the entries that adapter's own marker-based logic identifies as its
  own (requirement #9), gated behind the same `--yes`/interactive
  approval as `setup`.

## 11. Verification without model requests

- Every test in this phase (`test/setupClaudeAdapter.test.ts`,
  `test/setupCodexAdapter.test.ts`, `test/setupRun.test.ts`,
  `test/hookEventNeverInfers.test.ts`) runs against a disposable fixture
  directory (`mkdtemp`) or a fully in-memory fake adapter — never a real
  `claude`/`codex` process, and never a model call.
- Hook-event delivery and session registration are unchanged from Phase
  3B (`test/hookEvent.test.ts`, `test/desktopRegistry.test.ts`) — this
  phase adds no new delivery mechanism, only who installs the command
  that invokes the existing receiver.

## 12. A `Stop` event is evidence, never a conclusion

`test/hookEventNeverInfers.test.ts` asserts this directly: feeding a
`Stop` hook event through the existing `desktop hook-event` receiver
(`DesktopRegistry.recordEvidence`, Phase 3B, unchanged) appends exactly
one evidence entry and changes **nothing else** — not
`ownershipStatus`, not `observedActivity`, and (by construction — no
code path in this phase touches either) not any usage-exhaustion state.
No special-casing of the string `"Stop"` exists anywhere in
`parseHookEvent` or the registry.

## 13. Nothing touched your real configuration

Every `apply()`/`uninstall()` call made in building and testing this
phase targeted a path under a `mkdtemp()`-created temporary directory,
confirmed per-test and never your real `$HOME`. No command in this phase
was run against your actual `~/.claude/settings.json` or any Codex
configuration file.

## Explicitly deferred (per your instruction)

NPM packaging itself — publishing config, a README overhaul, any bin
metadata beyond what already exists — is **not** part of this phase; you
asked for it to land in "the upcoming setup and NPM packaging phase."
This phase only builds the subsystem that phase will package and expose.

## Capability matrix

| # | Capability | Status | Evidence |
|---|---|---|---|
| 5.1 | `agent-relay setup` discovers installed agents | **VERIFIED** (against injected detection) | §1; `test/setupRun.test.ts` |
| 5.2 | Automatic configuration only after explicit approval | **VERIFIED** (logic); approval gate itself is simple enough it wasn't separately re-tested beyond `hasFlag`/TTY-check inspection | §1 |
| 5.3 | Existing config/hooks/permissions/unrelated settings preserved | **VERIFIED** | §3; `test/setupClaudeAdapter.test.ts` ("preserves every unrelated hook...") |
| 5.4 | Backups created before any modification | **VERIFIED** | §3; backup-matches-original test |
| 5.5 | Absolute executable paths in hook commands | **VERIFIED** | §3; command-string assertion |
| 5.6 | Idempotent — no duplicate hooks, no corruption on repeat runs | **VERIFIED** | §3; idempotency tests |
| 5.7 | `integrations status` | **VERIFIED** | §7 |
| 5.8 | `integrations repair` | **VERIFIED** | §7; repair-only-what's-broken test |
| 5.9 | `integrations uninstall` removes only this tool's own entries | **VERIFIED** | §3/§7; uninstall preservation test |
| 5.10 | Extensible adapter interface | **VERIFIED** (interface + two real implementations; a third is a new class, nothing else to change) | §3 |
| 5.11 | Verified without model requests | **VERIFIED** | §11 |
| 5.12 | A `Stop` event proves nothing on its own | **VERIFIED** | §12; `test/hookEventNeverInfers.test.ts` |
| 5.13 | No real Claude/Codex configuration modified during this phase | **VERIFIED** (by construction — every test uses a disposable path) | §13 |

## Verification run (Phase 5, as originally shipped)

```
npm run typecheck   # tsc --noEmit — PASS
npm run lint        # eslint src test — PASS
npm run build       # tsc — PASS
npm run test        # tsc build + node --test — PASS (193/193: 169 pre-existing + 24 new)
```

---

## Phase 6 additions

Phase 6 ("Automated Setup & NPM Packaging") rounded this subsystem out
rather than replacing it — everything above is unchanged.

### Setup now covers OS/runtime detection and subscription auth

`agent-relay setup` and `agent-relay doctor` both now open with
`checkSetupPrerequisites()` (`src/setup/run.ts`):

- **Environment** (`src/setup/environment.ts`): `process.platform`/
  `process.version` against the required Node major version — plain,
  parameterized, no spawn at all. macOS-specific pieces (the launchd
  adapter) report `not_applicable` off-macOS rather than attempting
  anything.
- **Subscription auth, without reading credentials**
  (`src/setup/authCheck.ts`): reuses Phase 0's own already-proven
  read-only probes — `claude auth status --json` and `codex login
  status` — neither of which prints a token or opens a credential file.
  This is reporting only; it never gates `setup` on being authenticated.

### The background daemon is now one more approved `setup` change

`src/setup/daemonAdapter.ts`'s `DaemonLaunchdAdapter` implements the same
`IntegrationAdapter` interface as the Claude Code adapter, for the
launchd plist file specifically: `detect()` is macOS-only;
`plan()`/`apply()` write (or confirm) the plist Phase 4's
`generateLaunchdPlist()` already produces; `status()` distinguishes
missing/installed/broken (a plist whose referenced `cli.js` no longer
exists); `uninstall()` removes it, backup first. **It stops there** —
`apply()` never calls `launchctl` itself; actually loading the daemon
into launchd is the separate, explicit `agent-relay daemon activate`
(see `docs/INTEGRATIONS.md`).

### Claude Code hooks: more than one event, permissions preserved

`src/setup/claudeCodeAdapter.ts` now manages a small fixed list,
`MANAGED_HOOK_EVENTS = ["Stop", "SessionEnd"]`, looping the exact same
add/detect/remove logic per event instead of hardcoding `Stop` alone —
every installed hook entry also carries `"timeout": 5` (seconds, Claude
Code's own documented per-hook field), so a stuck `desktop hook-event`
process can never block or interrupt a real session. `apply()`/
`uninstall()` now also read the existing file's permission mode before
writing and `chmod` the new file back to exactly that mode afterward —
`writeJsonAtomic`'s plain `writeFile` would otherwise apply this
process's umask instead of preserving whatever the user's file already
had.

### Concurrent `setup` races, fixed

`src/setup/fileLock.ts` adds a small file lock — the same `O_EXCL`-create
+ PID-liveness-reclaim pattern `WorkspaceLockManager` (`src/handoff/
lock.ts`) already uses, generalized to an arbitrary file path — which
`ClaudeCodeAdapter`/`DaemonLaunchdAdapter`'s `apply()`/`uninstall()` now
acquire around their read-modify-write. Before this, two concurrent
`setup --yes` runs could each read "not present" and both append,
duplicating a hook; a dedicated test (`Promise.all([a.apply(), b.apply()])`
against the same file) proves exactly one hook entry survives.

### `agent-relay config show` / `config validate` / `doctor`

New CLI commands (`src/cli.ts`, logic in `src/daemon/config.ts`):
`config show` prints the resolved `DaemonConfig` (defaults merged,
redacted for consistency — there is nothing to redact, by the type's own
construction); `config validate` type/range-checks it
(`validateConfig()`) and reports problems as plain strings, never
throwing; `doctor` is the single aggregate health check requirement #6
asks for — environment, auth, daemon reachability, every integration's
`status()`, and config validity, in one report.

### Capability matrix additions (Phase 6)

| # | Capability | Status | Evidence |
|---|---|---|---|
| 6.S1 | OS/runtime detection | **VERIFIED** | `test/setupEnvironment.test.ts` |
| 6.S2 | Subscription auth check without reading credentials | **VERIFIED** (by construction — reuses Phase 0's own probes, reads only their already-public fields) | `src/setup/authCheck.ts` |
| 6.S3 | Background daemon configured as part of `setup` | **VERIFIED** | `test/setupDaemonAdapter.test.ts` |
| 6.S4 | Multiple managed hook events (`Stop`, `SessionEnd`), non-blocking timeout | **VERIFIED** | `test/setupClaudeAdapter.test.ts` |
| 6.S5 | File permissions preserved across apply/uninstall | **VERIFIED** | `test/setupClaudeAdapter.test.ts` ("preserves the original file's permission mode") |
| 6.S6 | Concurrent `setup` processes never duplicate a hook | **VERIFIED** | `test/setupClaudeAdapter.test.ts` ("concurrency: two apply() calls racing...") |
| 6.S7 | `config show`/`config validate`/`doctor` | **VERIFIED** | `test/daemonConfigValidate.test.ts` + CLI wiring |
