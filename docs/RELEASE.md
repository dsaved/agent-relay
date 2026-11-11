# Release process

**No version of this project has been published to the npm registry.**
This document describes what that would require — a deliberate,
human-gated sequence, not something any phase of this project's own
development has performed or automated.

## Why publication hasn't happened

Every phase of this project has worked under an explicit restriction:
no `npm publish` without separate authorization. `package.json` also
still has `"private": true`, which makes `npm publish` refuse outright
regardless of intent — a second, structural safeguard against an
accidental publish, not just a documented rule.

## What a real release would require

1. **Decide the version** (semver). This project is currently `0.1.0`
   and has never been published, so the first real release would
   reasonably stay pre-1.0 until the desktop-integration limitations in
   `docs/INTEGRATIONS.md` are resolved.
2. **Flip `"private": true` to `false`** in `package.json` — a one-line,
   deliberate, reviewed change, not a side effect of any build step.
3. **Write a CHANGELOG entry** summarizing what the release actually
   contains, in the same honest register as this project's own phase
   docs — what's verified, what's explicitly not.
4. **Run the full verification gate**: `npm run typecheck && npm run
   lint && npm run build && npm run test`, plus `npm pack --dry-run` to
   confirm the tarball contents are exactly what's intended (see
   `docs/INSTALLATION.md`).
5. **Dry-run the publish**: `npm publish --dry-run` — reports exactly
   what *would* be uploaded without uploading anything.
6. **Tag the release in git** (e.g. `git tag v0.1.0`) once the above is
   reviewed and approved by a human.
7. **Publish**, with explicit, separate authorization at the time:
   `npm publish` (add `--access public` if this is the first publish of
   a scoped package name). Two-factor/OTP as configured on the npm
   account.
8. **Verify post-publish**: `npm view agent-relay` and a real `npm
   install -g agent-relay` from the registry (not a local tarball) in a
   disposable environment, the same `--prefix`-isolated pattern
   `docs/INSTALLATION.md` already uses for local tarballs.

## Upgrading an existing installation

Once a real release exists:

```bash
npm install -g agent-relay@latest
agent-relay doctor
```

`doctor` re-validates the environment, every integration's status, and
config after an upgrade — the right first command to run afterward.
Upgrading never touches your existing `~/.claude/settings.json` or
`~/.agent-relay` state on its own; run `agent-relay integrations repair`
if `doctor`/`integrations status` reports anything `broken` (for
example, a hook pointing at a now-superseded install path).

## Capability matrix

| # | Capability | Status | Evidence |
|---|---|---|---|
| R.1 | No publication has occurred | **VERIFIED** (by construction — `private: true`; no `npm publish` call exists anywhere in this project) | `package.json` |
| R.2 | A real release's required steps are documented | **VERIFIED** (as documentation; the steps themselves are deliberately not automated or executed) | This document |
| R.3 | Upgrade path (`npm install -g agent-relay@latest` + `doctor`) | **VERIFIED** (logic — `doctor`'s own checks are exercised elsewhere; a real registry upgrade is, correctly, UNVERIFIED since no release exists to upgrade from) | `docs/SETUP.md` §Phase 6 additions |
