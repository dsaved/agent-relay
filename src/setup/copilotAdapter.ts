import { spawn } from "node:child_process";
import type { ApplyResult, DetectionResult, IntegrationAdapter, IntegrationStatus } from "./adapter.js";

export function checkCopilotCliAvailable(): Promise<{ installed: boolean; version: string | null }> {
  return new Promise((resolve) => {
    const proc = spawn("copilot", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    proc.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    proc.once("error", () => resolve({ installed: false, version: null }));
    proc.once("exit", (code) => resolve({ installed: code === 0, version: code === 0 ? stdout.trim() || null : null }));
  });
}

const NOOP_RESULT: ApplyResult = { applied: [], backupPaths: [], noopAlreadyUpToDate: true };

/**
 * Copilot CLI (confirmed via this machine's real `copilot --help`, see
 * docs/MULTI_AGENT.md) has no documented local hook/config file
 * analogous to Claude Code's `settings.json` — this phase does not
 * invent one. Same honest "detected, nothing to configure" pattern as
 * `CodexAdapter` — never silently skipped from the extensible adapter
 * list.
 */
export interface CopilotAdapterOptions {
  /** Defaults to the real `copilot --version` check; tests always inject a fake. */
  checkCliAvailable?: () => Promise<{ installed: boolean; version: string | null }>;
}

export class CopilotAdapter implements IntegrationAdapter {
  readonly id = "copilot";
  private readonly checkCliAvailable: () => Promise<{ installed: boolean; version: string | null }>;

  constructor(options: CopilotAdapterOptions = {}) {
    this.checkCliAvailable = options.checkCliAvailable ?? checkCopilotCliAvailable;
  }

  async detect(): Promise<DetectionResult> {
    const { installed, version } = await this.checkCliAvailable();
    return { installed, version, detail: installed ? `copilot CLI found (${version ?? "version unknown"})` : "copilot CLI was not found on PATH (checked via `copilot --version`)" };
  }

  async plan() {
    return [];
  }

  async apply(): Promise<ApplyResult> {
    return NOOP_RESULT;
  }

  async status(): Promise<IntegrationStatus> {
    const detection = await this.detect();
    return { id: this.id, detection, entries: [{ change: { kind: "add_hook", filePath: "", description: "Copilot CLI has no documented hook/config integration point" }, status: "not_applicable", detail: "nothing for this adapter to install" }] };
  }

  async repair(): Promise<ApplyResult> {
    return NOOP_RESULT;
  }

  async uninstall(): Promise<ApplyResult> {
    return NOOP_RESULT;
  }
}
