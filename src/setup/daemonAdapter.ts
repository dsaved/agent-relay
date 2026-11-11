import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { generateLaunchdPlist, plistPath, DEFAULT_LAUNCHD_LABEL } from "../daemon/launchd.js";
import { defaultStoreRoot } from "../handoff/store.js";
import { checkEnvironment } from "./environment.js";
import { withFileLock } from "./fileLock.js";
import { defaultSetupLockDir } from "./claudeCodeAdapter.js";
import type { ApplyResult, DetectionResult, IntegrationAdapter, IntegrationChange, IntegrationStatus } from "./adapter.js";

export interface DaemonLaunchdAdapterOptions {
  plistFilePath?: string;
  nodePath?: string;
  cliPath?: string;
  stateDir?: string;
  label?: string;
  lockDir?: string;
  platform?: NodeJS.Platform;
}

/**
 * Requirement #2's "configure the background daemon" setup step: writes
 * (or removes) the launchd plist `src/daemon/launchd.ts` already knows
 * how to generate. Deliberately stops there — it never calls
 * `launchctl` itself; activating/deactivating the written plist is a
 * separate, explicit `agent-relay daemon activate`/`deactivate` action
 * (requirement #5), kept out of this adapter's `apply()` so a `setup`
 * approval only ever means "write this file," never "also go load it
 * into launchd right now."
 */
export class DaemonLaunchdAdapter implements IntegrationAdapter {
  readonly id = "daemon-launchd";
  private readonly path: string;
  private readonly content: string;
  private readonly env: ReturnType<typeof checkEnvironment>;
  private readonly lockDir: string;

  constructor(options: DaemonLaunchdAdapterOptions = {}) {
    const label = options.label ?? DEFAULT_LAUNCHD_LABEL;
    this.path = options.plistFilePath ?? plistPath(label);
    this.env = checkEnvironment(22, options.platform ?? process.platform);
    this.content = generateLaunchdPlist({
      label,
      nodePath: options.nodePath ?? process.execPath,
      cliPath: options.cliPath ?? process.argv[1] ?? "agent-relay",
      stateDir: options.stateDir ?? defaultStoreRoot(),
    });
    this.lockDir = options.lockDir ?? defaultSetupLockDir();
  }

  async detect(): Promise<DetectionResult> {
    return {
      installed: this.env.isMacOS,
      version: this.env.nodeVersion,
      detail: this.env.isMacOS ? "macOS detected — launchd plist can be installed" : "not macOS — launchd activation is not applicable here; `daemon start`/`stop` still work directly",
    };
  }

  private async currentContent(): Promise<string | null> {
    try {
      return await readFile(this.path, "utf8");
    } catch {
      return null;
    }
  }

  private change(verb: "Write" | "Wrote" | "Removed" | "describe"): IntegrationChange {
    const text = verb === "describe" ? `launchd plist at ${this.path}` : `${verb} the launchd plist at ${this.path}`;
    return { kind: verb === "Removed" ? "remove_file" : "write_file", filePath: this.path, description: text };
  }

  async plan(): Promise<IntegrationChange[]> {
    const current = await this.currentContent();
    return current === this.content ? [] : [this.change("Write")];
  }

  async apply(): Promise<ApplyResult> {
    return withFileLock(this.path, this.lockDir, async () => {
      const current = await this.currentContent();
      if (current === this.content) return { applied: [], backupPaths: [], noopAlreadyUpToDate: true };

      let backupPath: string | null = null;
      if (current !== null) {
        backupPath = `${this.path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        await writeFile(backupPath, current);
      }
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, this.content);
      return { applied: [this.change("Wrote")], backupPaths: backupPath ? [backupPath] : [], noopAlreadyUpToDate: false };
    });
  }

  async status(): Promise<IntegrationStatus> {
    const detection = await this.detect();
    const current = await this.currentContent();
    if (current === null) return { id: this.id, detection, entries: [{ change: this.change("describe"), status: "missing", detail: "no plist file found" }] };
    if (current !== this.content) return { id: this.id, detection, entries: [{ change: this.change("describe"), status: "broken", detail: "a plist exists but its content doesn't match what this build would generate (stale paths/label?)" }] };

    const cliPathMatch = /<string>(.*cli\.js)<\/string>/.exec(current);
    if (cliPathMatch) {
      try {
        await access(cliPathMatch[1]!);
      } catch {
        return { id: this.id, detection, entries: [{ change: this.change("describe"), status: "broken", detail: `plist points at a cli.js that no longer exists: ${cliPathMatch[1]}` }] };
      }
    }
    return { id: this.id, detection, entries: [{ change: this.change("describe"), status: "installed", detail: "plist present and matches this build" }] };
  }

  async repair(): Promise<ApplyResult> {
    return this.apply();
  }

  async uninstall(): Promise<ApplyResult> {
    return withFileLock(this.path, this.lockDir, async () => {
      const current = await this.currentContent();
      if (current === null) return { applied: [], backupPaths: [], noopAlreadyUpToDate: true };
      const backupPath = `${this.path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await writeFile(backupPath, current);
      await rm(this.path, { force: true });
      return { applied: [this.change("Removed")], backupPaths: [backupPath], noopAlreadyUpToDate: false };
    });
  }
}
