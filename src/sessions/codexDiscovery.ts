import { ProcessCodexAppServerTransport, type CodexAppServerTransport } from "../codex/appServerTransport.js";
import type { DiscoveredSession } from "./types.js";

// Matches the subset of the `Thread` schema (from `codex app-server
// generate-json-schema`, v2/ThreadListResponse.json) that this adapter reads.
interface RawThreadStatus {
  type?: unknown;
}
interface RawGitInfo {
  branch?: unknown;
  sha?: unknown;
  originUrl?: unknown;
}
interface RawThread {
  id?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  status?: RawThreadStatus;
  name?: unknown;
  source?: unknown;
  originator?: unknown;
  updatedAt?: unknown;
  recencyAt?: unknown;
  gitInfo?: RawGitInfo | null;
}
interface RawThreadListResponse {
  data?: RawThread[];
  nextCursor?: unknown;
}

function toDiscoveredSession(thread: RawThread): DiscoveredSession | undefined {
  const id = typeof thread.sessionId === "string" ? thread.sessionId : typeof thread.id === "string" ? thread.id : undefined;
  if (!id) return undefined;

  // `source`/`originator` are how a historical thread records where it came
  // from (e.g. "vscode" + "Codex Desktop") — see docs/SESSION_DISCOVERY.md
  // for why that is a discovery signal, not a current-liveness one.
  const sourceParts = [thread.source, thread.originator].filter((v): v is string => typeof v === "string");
  const statusType = typeof thread.status?.type === "string" ? thread.status.type : "unknown";

  return {
    provider: "codex",
    sessionId: id,
    projectDir: typeof thread.cwd === "string" ? thread.cwd : null,
    status: statusType,
    lastActivity:
      typeof thread.recencyAt === "number"
        ? thread.recencyAt * 1000
        : typeof thread.updatedAt === "number"
          ? thread.updatedAt * 1000
          : null,
    discoverySource: sourceParts.length > 0 ? `codex-app-server:thread/list (${sourceParts.join(" / ")})` : "codex-app-server:thread/list",
    pid: null, // thread/list reports no OS process id — see docs/SESSION_DISCOVERY.md
    title: typeof thread.name === "string" ? thread.name : null,
    providerGitInfo: thread.gitInfo
      ? {
          branch: typeof thread.gitInfo.branch === "string" ? thread.gitInfo.branch : null,
          sha: typeof thread.gitInfo.sha === "string" ? thread.gitInfo.sha : null,
          originUrl: typeof thread.gitInfo.originUrl === "string" ? thread.gitInfo.originUrl : null,
        }
      : null,
  };
}

export interface CodexDiscoveryResult {
  sessions: DiscoveredSession[];
  error?: string;
}

/**
 * Discovers Codex sessions/threads — including Desktop/IDE-originated
 * ones, identifiable via `source`/`originator` — through the documented
 * `thread/list` app-server request, over this adapter's own isolated
 * `codex app-server --stdio` process (see src/codex/appServerTransport.ts
 * for why: never the shared daemon Desktop itself uses). Never throws.
 */
export async function discoverCodexSessions(
  transport: CodexAppServerTransport = new ProcessCodexAppServerTransport(),
  limit = 50,
): Promise<CodexDiscoveryResult> {
  try {
    const raw = await transport.request<unknown>("thread/list", { limit, archived: false });
    if (typeof raw !== "object" || raw === null || !Array.isArray((raw as RawThreadListResponse).data)) {
      return { sessions: [], error: "thread/list returned a response with no `data` array" };
    }
    const sessions: DiscoveredSession[] = [];
    for (const thread of (raw as RawThreadListResponse).data ?? []) {
      if (typeof thread !== "object" || thread === null) continue;
      const session = toDiscoveredSession(thread);
      if (session) sessions.push(session);
    }
    return { sessions };
  } catch (err) {
    return { sessions: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    await transport.close();
  }
}
