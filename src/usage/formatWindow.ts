import type { UsageWindow } from "./types.js";

export function formatUsageWindow(label: string, w: UsageWindow | null): string {
  if (!w) return `  ${label}: (not reported)`;
  const reset = w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : "unknown";
  const span = w.windowDurationMins ? `${w.windowDurationMins} min window` : "unknown window length";
  return `  ${label}: ${w.usedPercent}% used, resets ${reset} (${span})`;
}
