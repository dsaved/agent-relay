import { ProcessCodexAppServerTransport, type CodexAppServerTransport } from "./appServerTransport.js";

export type CodexUsageClassification = "available" | "exhausted" | "unknown";

export interface CodexUsageWindow {
  usedPercent: number;
  resetsAt: number | null;
  windowDurationMins: number | null;
}

export interface CodexUsageStatus {
  classification: CodexUsageClassification;
  /** epoch ms when this read was taken; set by CodexUsageMonitor.getStatus(), not by the pure classifier. Satisfies the common UsageSnapshot shape in src/usage/types.ts. */
  observedAt: number | null;
  ordinaryUsageAllowed: boolean | null;
  rateLimitReachedType: string | null;
  planType: string | null;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  /** set when classification is "unknown" because of a handled failure, not a genuinely ambiguous backend answer */
  error?: string;
}

// Matches the subset of `GetAccountRateLimitsResponse` (from
// `codex app-server generate-json-schema`) that this monitor reads.
interface RawRateLimitWindow {
  usedPercent?: unknown;
  resetsAt?: unknown;
  windowDurationMins?: unknown;
}
interface RawRateLimitSnapshot {
  rateLimitReachedType?: unknown;
  planType?: unknown;
  primary?: RawRateLimitWindow | null;
  secondary?: RawRateLimitWindow | null;
}
interface RawGetAccountRateLimitsResponse {
  ordinaryUsageAllowed?: unknown;
  rateLimits?: RawRateLimitSnapshot;
}

function toWindow(w: RawRateLimitWindow | null | undefined): CodexUsageWindow | null {
  if (!w || typeof w.usedPercent !== "number") return null;
  return {
    usedPercent: w.usedPercent,
    resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null,
    windowDurationMins: typeof w.windowDurationMins === "number" ? w.windowDurationMins : null,
  };
}

/**
 * Classifies a raw `account/rateLimits/read` response. Deliberately
 * conservative: per that response's own field doc ("Null means
 * unavailable; clients must not infer recovery from percentages or reset
 * times"), the absence of a definitive backend signal is reported as
 * "unknown", never guessed as "available".
 */
export function classifyAccountRateLimits(raw: unknown): CodexUsageStatus {
  if (typeof raw !== "object" || raw === null) {
    return {
      classification: "unknown",
      observedAt: null,
      ordinaryUsageAllowed: null,
      rateLimitReachedType: null,
      planType: null,
      primary: null,
      secondary: null,
      error: "malformed account/rateLimits/read response (not an object)",
    };
  }

  const resp = raw as RawGetAccountRateLimitsResponse;
  if (!resp.rateLimits || typeof resp.rateLimits !== "object") {
    return {
      classification: "unknown",
      observedAt: null,
      ordinaryUsageAllowed: null,
      rateLimitReachedType: null,
      planType: null,
      primary: null,
      secondary: null,
      error: "response is missing the required `rateLimits` field",
    };
  }

  const snapshot = resp.rateLimits;
  const reachedType = typeof snapshot.rateLimitReachedType === "string" ? snapshot.rateLimitReachedType : null;
  const ordinaryUsageAllowed = typeof resp.ordinaryUsageAllowed === "boolean" ? resp.ordinaryUsageAllowed : null;

  const classification: CodexUsageClassification =
    reachedType !== null || ordinaryUsageAllowed === false
      ? "exhausted"
      : ordinaryUsageAllowed === true
        ? "available"
        : "unknown";

  return {
    classification,
    observedAt: null,
    ordinaryUsageAllowed,
    rateLimitReachedType: reachedType,
    planType: typeof snapshot.planType === "string" ? snapshot.planType : null,
    primary: toWindow(snapshot.primary),
    secondary: toWindow(snapshot.secondary),
    ...(classification === "unknown" ? { error: "backend returned no definitive usage signal (ordinaryUsageAllowed is null and no rateLimitReachedType)" } : {}),
  };
}

/**
 * Reports Codex's account-level usage status without ever starting a
 * turn: the whole `account/rateLimits/read` round trip is a sibling of
 * `exec`/`resume`, not a side effect of one. See docs/FEASIBILITY.md,
 * Phase 1A, for the live verification this was checked against.
 */
export class CodexUsageMonitor {
  constructor(private readonly transport: CodexAppServerTransport = new ProcessCodexAppServerTransport()) {}

  async getStatus(): Promise<CodexUsageStatus> {
    try {
      const raw = await this.transport.request<unknown>("account/rateLimits/read", null);
      return { ...classifyAccountRateLimits(raw), observedAt: Date.now() };
    } catch (err) {
      return {
        classification: "unknown",
        observedAt: Date.now(),
        ordinaryUsageAllowed: null,
        rateLimitReachedType: null,
        planType: null,
        primary: null,
        secondary: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Subscribes to `account/rateLimits/updated` push notifications, when the server sends any; returns an unsubscribe function. */
  watch(onUpdate: (status: CodexUsageStatus) => void): () => void {
    return this.transport.onNotification("account/rateLimits/updated", (params) => {
      const p = params as { rateLimits?: unknown } | undefined;
      const raw = p?.rateLimits ? { rateLimits: p.rateLimits, ordinaryUsageAllowed: null } : null;
      onUpdate({ ...classifyAccountRateLimits(raw), observedAt: Date.now() });
    });
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
