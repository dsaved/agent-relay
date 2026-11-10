import type { UsageSnapshot } from "../usage/types.js";
import { formatUsageWindow } from "../usage/formatWindow.js";

/** Renders a UsageSnapshot for the `agent-relay usage claude` CLI command. */
export function formatClaudeUsageStatus(status: UsageSnapshot): string {
  if (status.error) {
    return [
      `Claude usage: UNKNOWN`,
      `  Could not determine usage status: ${status.error}`,
    ].join("\n");
  }

  const observed = status.observedAt ? new Date(status.observedAt).toISOString() : "never";
  return [
    `Claude usage: ${status.classification.toUpperCase()}`,
    `  observed at: ${observed}`,
    formatUsageWindow("primary (5h)", status.primary),
    formatUsageWindow("secondary (7d)", status.secondary),
  ].join("\n");
}
