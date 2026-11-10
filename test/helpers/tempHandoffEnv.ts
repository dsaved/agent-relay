import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionAssociation } from "../../src/sessions/types.js";

export function makeSessionAssociation(overrides: Partial<SessionAssociation>): SessionAssociation {
  return {
    provider: "codex",
    sessionId: "src-session-1",
    projectDir: null,
    status: "idle",
    lastActivity: null,
    discoverySource: "test",
    pid: null,
    title: "Implement the thing",
    providerGitInfo: null,
    repoRoot: null,
    worktreePath: null,
    workspaceAccessible: null,
    ...overrides,
  };
}

/** A disposable `~/.agent-relay`-shaped store root, outside any real user project, torn down after `run` returns or throws. */
export async function withTempStoreRoot(run: (storeRoot: string) => Promise<void>): Promise<void> {
  const storeRoot = await mkdtemp(join(tmpdir(), "agent-relay-store-"));
  try {
    await run(storeRoot);
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
  }
}
