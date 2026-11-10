import { discoverClaudeSessions } from "./claudeDiscovery.js";
import { discoverCodexSessions } from "./codexDiscovery.js";
import { associateSessions } from "./projectAssociation.js";
import type { SessionAssociation } from "./types.js";

export interface DiscoverAllResult {
  sessions: SessionAssociation[];
  errors: { provider: "codex" | "claude"; message: string }[];
}

/** Runs both providers' discovery adapters and associates the combined, deduped result with repos/worktrees. A failure in one provider never blocks the other. */
export async function discoverAllSessions(providers: ("codex" | "claude")[] = ["codex", "claude"]): Promise<DiscoverAllResult> {
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

  return { sessions: await associateSessions(raw), errors };
}
