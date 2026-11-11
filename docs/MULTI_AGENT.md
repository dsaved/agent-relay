# Multi-Agent Support

Agent Relay started as a Codex↔Claude relay. This document covers Phase
7's generalization to N providers, the one new provider it actually
wires up (GitHub Copilot CLI), the three it investigated and did not
build (Windsurf/Devin, Kiro, Kilo Code), and the checklist for adding
another one later.

## 1. From two providers to N

Before this phase, "the other provider" was hardcoded everywhere:
`SessionProvider = "codex" | "claude"`, `otherProvider()` in
`src/auto/providerSelection.ts`, and a `Record<SessionProvider, X>`
adapter map per provider in `HandoffEngine`/
`AutomaticHandoffCoordinator`.

`SessionProvider` is now `"codex" | "claude" | "copilot"` — still a
closed literal union, not an open `string`. Three (soon) providers don't
justify a dynamic plugin-loading system; adding a fourth is a fixed,
documented checklist (§4 below), not new infrastructure.

The real generalization is `candidateProviders(current, enabled,
pinned)` in `src/auto/providerSelection.ts`: every other *enabled*
provider, in `enabled`'s own order, collapsed to a single pinned choice
when one is set. `selectAlternativeProvider` walks that list in order,
running the same per-candidate `evaluateProviderAvailability` check as
before — a candidate on cooldown or exhausted falls through to the
next one instead of pausing immediately, which only matters once there
*is* a next one.

This is proven generic, not Copilot-specific:
`test/providerSelectionGeneralized.test.ts` enables a genuinely fake
4th provider (`"fake-fourth-provider" as SessionProvider`) alongside
codex/claude/copilot, puts the first two candidates on cooldown/
exhausted, and confirms selection falls all the way through to the fake
one. The same file also confirms the 2-provider case — no `enabled`
argument passed — still picks exactly what `otherProvider()` used to
pick, and the full pre-existing 217-test suite passes unmodified on top
of this change.

`enabledProviders` is a new field on `AutoTaskState` and
`DaemonConfig`, defaulting to `["codex", "claude"]` everywhere — a
third provider is opt-in, never silently activated for an existing
install.

## 2. GitHub Copilot CLI — what's actually wired up

Grounded in this machine's real `copilot --help` / `copilot sessions
--help` / `copilot login --help` / `copilot help billing` output
(v1.0.109, read-only, no prompt sent):

- **Execution** (`src/execution/copilotExecutionAdapter.ts`): `copilot
  -p "<instruction>" --output-format json --allow-tool write
  [--resume <id>]`, through the existing `spawnRun` unchanged — same
  process-group kill, timeout, and cancellation signal every other
  adapter gets for free. `--allow-tool write` is the narrowest grant
  that lets it edit files without a human answering prompts; `--allow-
  all`/`--yolo` is never used, same rule as Claude's `acceptEdits`/
  Codex's `workspace-write`.
- **Usage monitoring** (`src/copilot/usageMonitor.ts`): passive, same
  shape as `ClaudeUsageMonitor` — there is no zero-turn usage endpoint
  (`/usage` is an interactive-only slash command), so
  `CopilotUsageMonitor` only classifies lines handed to it from a real
  session already running for real work, never probes on its own.
- **Setup/integration** (`src/setup/copilotAdapter.ts`): `detect()` via
  `copilot --version`; `plan()`/`apply()`/`uninstall()` are no-ops —
  Copilot has no documented local hook/config file analogous to Claude
  Code's `settings.json`, and this phase doesn't invent one. Registered
  in `defaultAdapters()` so `setup`/`integrations status`/`doctor`
  report it honestly (installed, nothing to configure).
- **Auth check** (`src/setup/authCheck.ts`): no `status`/`whoami`
  subcommand exists, so `checkCopilotAuthStatus()` reports `unknown`
  rather than guessing from CLI presence alone.

**Confirmed `UNSUPPORTED`, not worked around**: session discovery.
`copilot sessions` has exactly one subcommand, `import` — no `list`/
`--json` enumeration exists. `discoverAllSessions` reports this as an
explicit error entry for Copilot rather than silently returning nothing;
Copilot can still be a handoff *destination*, just never an
automatically-discovered *source*.

**Still `UNVERIFIED`**: the exact JSON event shape `--output-format
json` emits for a real completed/failed run. `interpretCopilotRun`
(`src/execution/outcomeClassifier.ts`) does best-effort classification
today — a zero exit code is `completed`, a non-zero one is matched
against the same shared rate-limit/auth/context/permission patterns the
other classifiers use. Confirming the real shape needs one bounded live
`copilot -p` prompt, which is a separate, explicit ask — not run during
this phase's planning or implementation, same gate every other live
call in this project's history has gone through.

## 3. Investigated, not built

| Agent | Non-interactive mode | Auth | Why not this phase |
|---|---|---|---|
| **Windsurf** | Uncertain | — | Reportedly folded into Cognition's "Devin Desktop" after acquisition; billing moved to credit-based ACUs, not a flat subscription. Needs its own from-scratch feasibility check — not attempted here. **Would become eligible if**: a standalone, flat-subscription Windsurf/Devin CLI with documented non-interactive auth still exists, re-confirmed independently of this phase's research. |
| **Kiro (AWS)** | Yes (`kiro-cli --no-interactive`) | Documented headless auth is an **API key** (`KIRO_API_KEY`) | Conflicts with this project's no-API-keys rule as documented. **Would become eligible if**: a subscription-login session (not an API key) can drive the headless CLI too — unconfirmed. |
| **Kilo Code** | Yes (`kilocode --auto` / `kilo run`) | Bring-your-own-key or Kilo's own metered credits | Fundamentally BYOK/metered, not a flat-subscription CLI. **Would become eligible if**: Kilo ships a flat-subscription auth mode with no per-token billing. |

## 4. Adding a new provider — the checklist

1. Confirm it has a non-interactive mode and a subscription-only
   (not API-key, not metered) auth path. If either is missing, stop —
   document it in §3 above instead of writing code.
2. Add the literal to `SessionProvider` (`src/sessions/types.ts`).
3. Write its three adapters, mirroring the Copilot ones above:
   - an `AgentExecutionAdapter` in `src/execution/`, plus an
     `interpretXRun` in `src/execution/outcomeClassifier.ts`.
   - a `UsageMonitor` in `src/<provider>/usageMonitor.ts` — passive
     unless the CLI genuinely has a zero-turn usage endpoint (only
     Codex does today).
   - an `IntegrationAdapter` in `src/setup/<provider>Adapter.ts`, and an
     auth-status check in `src/setup/authCheck.ts`.
4. Register it: `ALL_PROVIDERS`/`DEFAULT_CONFIG.enabledProviders` stay
   opt-in (don't add it there), but `KNOWN_PROVIDERS` in
   `src/daemon/config.ts`, the adapter-map construction in
   `HandoffEngine`/`AutomaticHandoffCoordinator`, and
   `defaultAdapters()` in `src/setup/run.ts` all need the new provider
   added explicitly.
5. Decide discovery honestly: wire it into
   `src/sessions/discoverAll.ts` only if a real session-listing
   interface exists; otherwise add an explicit "unsupported" error
   entry, same as Copilot's.
6. Mirror the five Copilot test files in `test/` for the new provider,
   plus one bounded live call (separately authorized) to confirm the
   real JSON event shape before removing any `UNVERIFIED` label.
