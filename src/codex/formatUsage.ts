import type { CodexUsageStatus } from "./usageMonitor.js";
import { formatUsageWindow } from "../usage/formatWindow.js";

/** Renders a CodexUsageStatus for the `agent-relay usage codex` CLI command. */
export function formatCodexUsageStatus(status: CodexUsageStatus): string {
  if (status.error) {
    return [
      `Codex usage: UNKNOWN`,
      `  Could not determine usage status: ${status.error}`,
    ].join("\n");
  }

  const lines = [
    `Codex usage: ${status.classification.toUpperCase()}`,
    `  plan: ${status.planType ?? "unknown"}`,
    `  ordinaryUsageAllowed: ${status.ordinaryUsageAllowed ?? "unknown"}`,
    `  rateLimitReachedType: ${status.rateLimitReachedType ?? "none"}`,
    formatUsageWindow("primary", status.primary),
    formatUsageWindow("secondary", status.secondary),
  ];
  return lines.join("\n");
}
