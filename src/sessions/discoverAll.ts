import { discoverClaudeSessions } from "./claudeDiscovery.js";
import { discoverCodexSessions } from "./codexDiscovery.js";
import { associateSessions } from "./projectAssociation.js";
import type { SessionAssociation, SessionProvider } from "./types.js";

export interface DiscoverAllResult {
  sessions: SessionAssociation[];
  errors: { provider: SessionProvider; message: string }[];
}

/**
 * Runs every requested provider's discovery adapter and associates the
 * combined, deduped result with repos/worktrees. A failure in one
 * provider never blocks the others.
 *
 * Copilot has no documented session-listing interface (confirmed via
 * `copilot sessions --help` — its only subcommand is `import`; see
 * docs/MULTI_AGENT.md) — requesting it is reported as an honest,
 * explicit error, not silently dropped or guessed at. It still works
 * fine as a handoff *destination*; it just can't be an auto-discovered
 * *source* yet.
 */
export async function discoverAllSessions(providers: SessionProvider[] = ["codex", "claude"]): Promise<DiscoverAllResult> {
  const errors: DiscoverAllResult["errors"] = [];
  const raw = [];

  if (providers.includes("claude")) {
    const result = await discoverClaudeSessions();
    if (result.error) errors.push({ provider: "claude", message: result.error });
    raw.push(...result.sessions);
  }
  if (providers.includes("codex")) {
    const result = await discoverCodexSessions();
    if (result.error) errors.push({ provider: "codex", message: result.error });
    raw.push(...result.sessions);
  }
  if (providers.includes("copilot")) {
    errors.push({ provider: "copilot", message: "Copilot has no documented session-listing interface — discovery is unsupported (it can still be a handoff destination)" });
  }

  return { sessions: await associateSessions(raw), errors };
}
