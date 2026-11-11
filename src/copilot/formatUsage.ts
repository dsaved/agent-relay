import type { UsageSnapshot } from "../usage/types.js";

/** Renders a UsageSnapshot for the `agent-relay usage copilot` CLI command. No usage windows are rendered — see src/copilot/usageMonitor.ts on why Copilot's usage signal has no confirmed structured shape yet. */
export function formatCopilotUsageStatus(status: UsageSnapshot): string {
  if (status.error) {
    return [`Copilot usage: UNKNOWN`, `  Could not determine usage status: ${status.error}`].join("\n");
  }
  const observed = status.observedAt ? new Date(status.observedAt).toISOString() : "never";
  return [`Copilot usage: ${status.classification.toUpperCase()}`, `  observed at: ${observed}`].join("\n");
}
