# Fixtures

- `codex-usage-limit.jsonl` — **real** captured output from
  `codex exec --json "..."` on this machine, run during Phase 0 feasibility
  testing. Hit the account's actual usage limit, which is exactly the event
  shape we need to classify. Unmodified except for whitespace.
- `codex-success.jsonl` — **synthetic**. Codex's `--json` stream never
  reached a successful turn during testing (account was rate-limited for the
  whole session), so this is reconstructed from the `agent_message` item
  type documented in `codex app-server generate-json-schema`'s output, not
  captured live. Marked UNVERIFIED in docs/FEASIBILITY.md.
- `claude-rate-limit-ok.jsonl` — **real**, trimmed from a live
  `claude -p --output-format stream-json` run (the `assistant` message,
  `rate_limit_event`, and final `result` lines only; the large `system/init`
  line was dropped as noise, not for sensitivity).
- `claude-rate-limit-exhausted.jsonl` — **mocked**, per the task's
  instruction to test subscription-limit classification with mocked events
  rather than deliberately exhausting a Claude subscription. Shaped to match
  the real `rate_limit_event` schema above with `status` flipped to
  `"rejected"`.

## Phase 1A (Codex `app-server` protocol)

- `codex-account-rate-limits-exhausted.json` — **real**, captured live via
  the `account/rateLimits/read` JSON-RPC request against this machine's
  actually-exhausted Codex subscription. Only `accountId` and the
  server-rendered upsell banner copy were stripped.
- `codex-account-rate-limits-available.json` — **mocked**. The real
  account was exhausted for the whole session, so there was no live
  "available" response to capture; this is reconstructed from the same
  `GetAccountRateLimitsResponse` schema with the usage fields flipped.
