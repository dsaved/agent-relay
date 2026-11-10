import { spawn } from "node:child_process";
import type { DiscoveredSession } from "./types.js";

/**
 * Runs `claude agents --json` (documented, read-only, no model prompt —
 * see docs/FEASIBILITY.md Phase 0 #11) and returns its raw stdout.
 */
export function runClaudeAgentsJson(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["agents", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    proc.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    proc.once("error", (err: Error & { code?: string }) => {
      reject(err.code === "ENOENT" ? new Error("`claude` CLI was not found on PATH") : err);
    });
    proc.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude agents --json exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

interface RawClaudeAgentEntry {
  pid?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  name?: unknown;
  status?: unknown;
  startedAt?: unknown;
}

function toDiscoveredSession(entry: RawClaudeAgentEntry): DiscoveredSession | undefined {
  if (typeof entry.sessionId !== "string") return undefined;
  return {
    provider: "claude",
    sessionId: entry.sessionId,
    projectDir: typeof entry.cwd === "string" ? entry.cwd : null,
    status: typeof entry.status === "string" ? entry.status : "unknown",
    lastActivity: typeof entry.startedAt === "number" ? entry.startedAt : null,
    discoverySource: "claude-cli:agents --json",
    pid: typeof entry.pid === "number" ? entry.pid : null,
    title: typeof entry.name === "string" ? entry.name : null,
    providerGitInfo: null,
  };
}

export interface ClaudeDiscoveryResult {
  sessions: DiscoveredSession[];
  error?: string;
}

/**
 * Discovers Claude sessions (terminal- or Desktop-Code-tab-originated —
 * `claude agents --json` enumerates both, see docs/FEASIBILITY.md Phase
 * 0 #11) without reading any credential file or connecting to any
 * socket. Never throws: a missing CLI or malformed output is reported in
 * `error`, with an empty session list, not an exception.
 */
export async function discoverClaudeSessions(
  runAgentsJson: () => Promise<string> = runClaudeAgentsJson,
): Promise<ClaudeDiscoveryResult> {
  let stdout: string;
  try {
    stdout = await runAgentsJson();
  } catch (err) {
    return { sessions: [], error: err instanceof Error ? err.message : String(err) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { sessions: [], error: "claude agents --json did not return valid JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { sessions: [], error: "claude agents --json returned JSON that was not an array" };
  }

  const sessions: DiscoveredSession[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue; // skip, don't fail the whole batch
    const session = toDiscoveredSession(entry as RawClaudeAgentEntry);
    if (session) sessions.push(session);
  }
  return { sessions };
}
