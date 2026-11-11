# Installation

Agent Relay is a CLI tool: `node` + `npm` + a subscription-authenticated
install of the Claude Code and/or Codex CLIs on macOS. It uses only
subscription authentication — no API keys, no model SDKs, no pay-per-token
billing. It never needs, and never reads, your Claude or Codex credentials
during installation.

## Requirements

| | |
|---|---|
| OS | macOS (the background daemon's `launchctl` integration is macOS-only; everything else is portable, but this project has only been exercised on macOS) |
| Node.js | `>=22` (declared in `package.json`'s `engines` field; `agent-relay doctor`/`setup` report your actual version against this) |
| Claude Code CLI | optional — needed for the Claude Code integration (`claude` on `PATH`, authenticated via `claude auth status`) |
| Codex CLI | optional — needed for Codex session discovery/usage monitoring (`codex` on `PATH`, authenticated via `codex login status`) |

Neither Claude Code nor Codex needs to be installed for `agent-relay`
itself to install and run — `setup`/`doctor` report each one as
"not found" rather than failing.

## Packaging

`package.json`:
- `"bin": { "agent-relay": "dist/src/cli.js" }` — a single executable,
  shebang `#!/usr/bin/env node` already in the file.
- `"files": ["dist/src"]` — only the built library/CLI ships; `dist/test`,
  the TypeScript sources, and this repo's own tests/fixtures are excluded
  from the npm package.
- `"exports": "./dist/src/cli.js"` — present for packaging correctness;
  this package has no stable *programmatic* API — it's a CLI, not a
  library to `import`.
- `"private": true` — left in place deliberately. It makes `npm publish`
  refuse by itself; flipping it is a distinct, human-gated step covered
  in `docs/RELEASE.md`, never done as part of ordinary development.
- Zero runtime dependencies (only `devDependencies`) — nothing to fetch
  from a registry when installing from a local tarball.

## Verify `npm pack` contents

```bash
npm pack --dry-run
```

This lists every file the published tarball would contain without
writing one. Confirm it includes `dist/src/cli.js` and
`dist/src/daemon/process.js` (the launchd `ProgramArguments` target) and
excludes `node_modules/`, `test/`, and `.git/`. To actually produce and
inspect the tarball:

```bash
npm pack --pack-destination /tmp/agent-relay-pack
tar -tzf /tmp/agent-relay-pack/agent-relay-*.tgz
```

## Install globally from a local tarball

The real way to test a global install without touching your actual
global npm state is `--prefix` into a disposable directory:

```bash
npm pack --pack-destination /tmp/agent-relay-pack
npm install -g /tmp/agent-relay-pack/agent-relay-*.tgz --prefix /tmp/agent-relay-test-install
/tmp/agent-relay-test-install/bin/agent-relay --help
```

This is exactly what `test/integrationLifecycle.test.ts` does, for real,
in an isolated scratch directory, every time the test suite runs — see
the capability matrix below.

For a real global install on your own machine:

```bash
npm install -g /path/to/agent-relay-0.1.0.tgz
agent-relay --help
```

**No publication to the npm registry has happened or is implied by any
of the above** — see `docs/RELEASE.md` for what that would additionally
require, and this project's own restriction against publishing without
separate authorization.

## First run

```bash
agent-relay setup
```

See `docs/SETUP.md` for exactly what this detects and proposes, and
`docs/INTEGRATIONS.md` for what each integration does and how to manage
it afterward.

## Capability matrix

| # | Capability | Status | Evidence |
|---|---|---|---|
| I.1 | Correct `bin`/`files`/`exports`/engines | **VERIFIED** | `package.json`; `npm pack --dry-run` content inspection |
| I.2 | `npm pack` contents are exactly what's intended | **VERIFIED** | Manually run and inspected during this phase; re-verified automatically every run of `test/integrationLifecycle.test.ts` |
| I.3 | Global install from a local tarball, in an isolated environment | **VERIFIED** | `test/integrationLifecycle.test.ts` (`npm install -g <tarball> --prefix <disposable dir>`) |
| I.4 | The installed binary works outside the source repository | **VERIFIED** | Same test: invoked from a `cwd` outside the repo, with `HOME`/`AGENT_RELAY_HOME` pointed at disposable directories, not this checkout |
| I.5 | No publication to npm | **VERIFIED** (by construction — `private: true`, and no `npm publish` call exists anywhere in this project's scripts or tests) | `package.json` |
