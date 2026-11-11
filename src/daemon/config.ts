import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionProvider } from "../sessions/types.js";
import type { UnknownAvailabilityPolicy } from "../auto/types.js";

/**
 * Requirement #8's persistent configuration. Deliberately has **no field
 * for a password, subscription token, or API key** — not merely left
 * blank, there is nowhere in this type to put one.
 */
export interface DaemonConfig {
  /** Absolute paths the daemon is willing to orchestrate tasks for. Empty by default — nothing is registered automatically. */
  registeredProjects: string[];
  enabledProviders: SessionProvider[];
  preferredStartingProvider: SessionProvider | null;
  desktopPollIntervalMs: number;
  /** The scheduler refuses a new `submit()` past this count — "default to one active writing task per workspace" is enforced separately, by the existing `WorkspaceLockManager`, unchanged. */
  maxConcurrentTasks: number;
  maxHandoffs: number;
  maxAttempts: number;
  maxRuntimeMs: number;
  unknownAvailabilityPolicy: UnknownAvailabilityPolicy;
  validationCommands: string[];
  logLevel: "info" | "debug";
  logRetentionDays: number;
}

export const DEFAULT_CONFIG: DaemonConfig = {
  registeredProjects: [],
  enabledProviders: ["codex", "claude"],
  preferredStartingProvider: null,
  desktopPollIntervalMs: 60_000,
  maxConcurrentTasks: 4,
  maxHandoffs: 6,
  maxAttempts: 6,
  maxRuntimeMs: 60 * 60_000,
  unknownAvailabilityPolicy: { allow: false, maxAttempts: 2, cooldownMs: 60_000 },
  validationCommands: [],
  logLevel: "info",
  logRetentionDays: 14,
};

export function configPath(stateDir: string): string {
  return join(stateDir, "config.json");
}

/** Never required to exist — absence is just the defaults, not an error. A malformed file is reported, not thrown, so the daemon never fails to start over one bad edit. */
export async function loadConfig(stateDir: string): Promise<{ config: DaemonConfig; error?: string }> {
  let raw: string;
  try {
    raw = await readFile(configPath(stateDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { config: DEFAULT_CONFIG };
    return { config: DEFAULT_CONFIG, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonConfig>;
    return { config: { ...DEFAULT_CONFIG, ...parsed } };
  } catch {
    return { config: DEFAULT_CONFIG, error: `${configPath(stateDir)} is not valid JSON — using defaults` };
  }
}

export async function saveConfig(stateDir: string, config: DaemonConfig): Promise<void> {
  await mkdir(dirname(configPath(stateDir)), { recursive: true });
  await writeFile(configPath(stateDir), JSON.stringify(config, null, 2));
}

const KNOWN_PROVIDERS: SessionProvider[] = ["codex", "claude"];

/**
 * `agent-relay config validate` — deliberately stricter than `loadConfig`'s
 * loose "merge over defaults" (which exists so a slightly-stale file
 * never blocks startup): type/range checks a human edit could easily get
 * wrong, reported as plain strings, never thrown.
 */
export function validateConfig(config: DaemonConfig): string[] {
  const problems: string[] = [];

  if (!Array.isArray(config.registeredProjects) || !config.registeredProjects.every((p) => typeof p === "string")) {
    problems.push("registeredProjects must be an array of strings");
  }
  if (!Array.isArray(config.enabledProviders) || config.enabledProviders.length === 0 || !config.enabledProviders.every((p) => KNOWN_PROVIDERS.includes(p))) {
    problems.push(`enabledProviders must be a non-empty array drawn from ${JSON.stringify(KNOWN_PROVIDERS)}`);
  }
  if (config.preferredStartingProvider !== null && !KNOWN_PROVIDERS.includes(config.preferredStartingProvider)) {
    problems.push(`preferredStartingProvider must be null or one of ${JSON.stringify(KNOWN_PROVIDERS)}`);
  }
  for (const [field, value] of Object.entries({ desktopPollIntervalMs: config.desktopPollIntervalMs, maxConcurrentTasks: config.maxConcurrentTasks, maxHandoffs: config.maxHandoffs, maxAttempts: config.maxAttempts, maxRuntimeMs: config.maxRuntimeMs })) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) problems.push(`${field} must be a positive number`);
  }
  if (typeof config.logRetentionDays !== "number" || !Number.isFinite(config.logRetentionDays) || config.logRetentionDays < 0) {
    problems.push("logRetentionDays must be a non-negative number");
  }
  if (config.logLevel !== "info" && config.logLevel !== "debug") {
    problems.push('logLevel must be "info" or "debug"');
  }
  if (!Array.isArray(config.validationCommands) || !config.validationCommands.every((c) => typeof c === "string")) {
    problems.push("validationCommands must be an array of strings");
  }
  const policy = config.unknownAvailabilityPolicy;
  if (typeof policy !== "object" || policy === null || typeof policy.allow !== "boolean" || typeof policy.maxAttempts !== "number" || policy.maxAttempts < 0 || typeof policy.cooldownMs !== "number" || policy.cooldownMs < 0) {
    problems.push("unknownAvailabilityPolicy must be { allow: boolean, maxAttempts: >=0, cooldownMs: >=0 }");
  }

  return problems;
}
