import { spawn } from "node:child_process";
import type { ApplyResult, DetectionResult, IntegrationAdapter, IntegrationStatus } from "./adapter.js";

export function checkCodexCliAvailable(): Promise<{ installed: boolean; version: string | null }> {
  return new Promise((resolve) => {
    const proc = spawn("codex", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    proc.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    proc.once("error", () => resolve({ installed: false, version: null }));
    proc.once("exit", (code) => resolve({ installed: code === 0, version: code === 0 ? stdout.trim() || null : null }));
  });
}

const NOOP_RESULT: ApplyResult = { applied: [], backupPaths: [], noopAlreadyUpToDate: true };

/**
 * Codex has no documented hook or config-file integration point — Phase
 * 0/2A/3B already established this (`docs/SESSION_DISCOVERY.md` §1,
 * `docs/DESKTOP_INTEGRATION.md` §3), and this phase does not reopen that
 * investigation or invent an undocumented one. This adapter exists so
 * Codex still shows up in `setup`/`integrations status` honestly — as
 * "detected, nothing to configure" — rather than being silently skipped
 * from the extensible adapter list (requirement #10).
 */
export interface CodexAdapterOptions {
  /** Defaults to the real `codex --version` check; tests always inject a fake. */
  checkCliAvailable?: () => Promise<{ installed: boolean; version: string | null }>;
}

export class CodexAdapter implements IntegrationAdapter {
  readonly id = "codex";
  private readonly checkCliAvailable: () => Promise<{ installed: boolean; version: string | null }>;

  constructor(options: CodexAdapterOptions = {}) {
    this.checkCliAvailable = options.checkCliAvailable ?? checkCodexCliAvailable;
  }

  async detect(): Promise<DetectionResult> {
    const { installed, version } = await this.checkCliAvailable();
    return { installed, version, detail: installed ? `codex CLI found (${version ?? "version unknown"})` : "codex CLI was not found on PATH (checked via `codex --version`)" };
  }

  async plan() {
    return [];
  }

  async apply(): Promise<ApplyResult> {
    return NOOP_RESULT;
  }

  async status(): Promise<IntegrationStatus> {
    const detection = await this.detect();
    return { id: this.id, detection, entries: [{ change: { kind: "add_hook", filePath: "", description: "Codex has no documented hook/config integration point" }, status: "not_applicable", detail: "nothing for this adapter to install" }] };
  }

  async repair(): Promise<ApplyResult> {
    return NOOP_RESULT;
  }

  async uninstall(): Promise<ApplyResult> {
    return NOOP_RESULT;
  }
}
