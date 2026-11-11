import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LAUNCHD_LABEL = "com.agent-relay.daemon";

export interface LaunchdPlistOptions {
  label?: string;
  /** `process.execPath` — the exact node binary this was built/run under. */
  nodePath: string;
  /** Absolute path to the built `dist/src/cli.js`. */
  cliPath: string;
  stateDir: string;
}

export function launchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

export function plistPath(label: string = DEFAULT_LAUNCHD_LABEL): string {
  return join(launchAgentsDir(), `${label}.plist`);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Requirement #2's plist generation. `RunAtLoad` + `KeepAlive` (restricted
 * to `SuccessfulExit: false`, so a clean, intentional exit — e.g. a future
 * `daemon stop` that actually kills the launchd job — doesn't get
 * relaunched in a loop, only a crash does) satisfy "restart after
 * unexpected termination" and "startup on user login". This function only
 * returns a string — see `src/cli.ts`'s `daemon install` command for why
 * writing the file is as far as this goes without a separate go-ahead.
 */
export function generateLaunchdPlist(options: LaunchdPlistOptions): string {
  const label = options.label ?? DEFAULT_LAUNCHD_LABEL;
  const logDir = join(options.stateDir, "logs");
  const args = [options.nodePath, options.cliPath, "daemon", "run-foreground"].map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDir, "launchd.err.log"))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export interface LaunchctlResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** The real, injectable `launchctl` runner — tests always inject a fake; this session never invokes this one against the real system. */
export function defaultLaunchctlRunner(args: string[]): Promise<LaunchctlResult> {
  return new Promise((resolve) => {
    const proc = spawn("launchctl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    proc.stderr?.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    proc.once("error", () => resolve({ exitCode: null, stdout: "", stderr: "launchctl was not found on PATH" }));
    proc.once("exit", (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}

export type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;

export function launchdDomainTarget(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

export function launchdServiceTarget(label: string = DEFAULT_LAUNCHD_LABEL): string {
  return `${launchdDomainTarget()}/${label}`;
}

/** Read-only: `launchctl print` exits 0 only when the service is actually loaded. Used both by `activate`/`deactivate` (for idempotency) and by `daemon start`'s single-lifecycle-owner check (requirement #5). */
export async function isLoaded(label: string = DEFAULT_LAUNCHD_LABEL, runner: LaunchctlRunner = defaultLaunchctlRunner): Promise<boolean> {
  const result = await runner(["print", launchdServiceTarget(label)]);
  return result.exitCode === 0;
}

/** Idempotent: a no-op, not an error, when already loaded. */
export async function activate(plistFile: string, label: string = DEFAULT_LAUNCHD_LABEL, runner: LaunchctlRunner = defaultLaunchctlRunner): Promise<{ changed: boolean; detail: string }> {
  if (await isLoaded(label, runner)) return { changed: false, detail: `${label} is already loaded` };
  const result = await runner(["bootstrap", launchdDomainTarget(), plistFile]);
  if (result.exitCode !== 0) throw new Error(`launchctl bootstrap failed: ${result.stderr || result.stdout || `exit code ${result.exitCode}`}`);
  return { changed: true, detail: `${label} loaded via launchctl bootstrap` };
}

/** Idempotent: a no-op, not an error, when already unloaded. */
export async function deactivate(label: string = DEFAULT_LAUNCHD_LABEL, runner: LaunchctlRunner = defaultLaunchctlRunner): Promise<{ changed: boolean; detail: string }> {
  if (!(await isLoaded(label, runner))) return { changed: false, detail: `${label} is already not loaded` };
  const result = await runner(["bootout", launchdServiceTarget(label)]);
  if (result.exitCode !== 0) throw new Error(`launchctl bootout failed: ${result.stderr || result.stdout || `exit code ${result.exitCode}`}`);
  return { changed: true, detail: `${label} unloaded via launchctl bootout` };
}
