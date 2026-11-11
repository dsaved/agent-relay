import type { AutoTaskState, AutoTransition } from "./types.js";

export function formatAutoTaskState(state: AutoTaskState): string {
  const lines = [
    `Automatic task ${state.taskId}`,
    `  state: ${state.state}`,
    `  current provider: ${state.currentProvider ?? "unknown"}`,
    `  current handoff: ${state.currentHandoffId ?? "none"}`,
    `  attempts: ${state.attemptCount}/${state.limits.maxAttempts}, handoffs: ${state.handoffCount}/${state.limits.maxHandoffs}`,
    `  runtime: ${Math.round((Date.now() - state.startedAt) / 1000)}s / ${Math.round(state.limits.maxRuntimeMs / 1000)}s max`,
    `  unknown-availability policy: ${state.unknownAvailabilityPolicy.allow ? `allowed, up to ${state.unknownAvailabilityPolicy.maxAttempts} attempt(s)/provider` : "disabled (paused instead)"}`,
  ];
  const cooldownEntries = Object.entries(state.cooldowns).filter(([, c]) => c);
  if (cooldownEntries.length > 0) {
    lines.push("  cooldowns:");
    for (const [provider, cooldown] of cooldownEntries) {
      lines.push(`    ${provider}: until ${new Date(cooldown!.until).toISOString()} (${cooldown!.reason})`);
    }
  }
  if (state.pendingProviderChoice) lines.push(`  awaiting destination choice: ${state.pendingProviderChoice.join(", ")} — resume with \`auto resume ${state.taskId} --pin <provider>\``);
  if (state.failureReason) lines.push(`  failure reason: ${state.failureReason}`);
  if (state.lastOutcome) lines.push(`  last outcome: ${state.lastOutcome.kind}${state.lastOutcome.detail ? ` (${state.lastOutcome.detail})` : ""}`);
  return lines.join("\n");
}

export function formatAutoHistory(transitions: AutoTransition[]): string {
  if (transitions.length === 0) return "No transitions recorded yet.";
  return transitions
    .map((t, i) => `#${i + 1} [${t.attemptId.slice(0, 8)}] ${new Date(t.at).toISOString()} ${t.from} -> ${t.to}${t.provider ? ` (${t.provider})` : ""}${t.reason ? `: ${t.reason}` : ""}`)
    .join("\n");
}
