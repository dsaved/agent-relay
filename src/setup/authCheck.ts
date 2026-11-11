import { spawn } from "node:child_process";
import type { SessionProvider } from "../sessions/types.js";

export interface AuthStatus {
  provider: SessionProvider;
  authenticated: boolean;
  detail: string;
}

/**
 * Requirement #2's "check subscription authentication without reading
 * credentials" — reuses exactly the read-only probes Phase 0 already
 * proved safe (`docs/FEASIBILITY.md` Phase 0 #3/#4): `claude auth
 * status --json` and `codex login status`. Neither reads a credential
 * file; neither prints a token. Only the fields these commands already
 * surface (`authMethod`, or the literal "Logged in" phrase) are read —
 * nothing here opens `~/.codex/auth.json` or any Claude keychain entry.
 */
export function checkClaudeAuthStatus(): Promise<AuthStatus> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["auth", "status", "--json"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    proc.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    proc.once("error", () => resolve({ provider: "claude", authenticated: false, detail: "claude CLI was not found on PATH" }));
    proc.once("exit", (code) => {
      if (code !== 0) return resolve({ provider: "claude", authenticated: false, detail: "claude auth status exited non-zero" });
      try {
        const parsed = JSON.parse(stdout) as { authMethod?: unknown; subscriptionType?: unknown };
        const authenticated = typeof parsed.authMethod === "string" && parsed.authMethod.length > 0;
        resolve({ provider: "claude", authenticated, detail: authenticated ? `authenticated via ${parsed.authMethod}${typeof parsed.subscriptionType === "string" ? ` (${parsed.subscriptionType})` : ""}` : "not authenticated" });
      } catch {
        resolve({ provider: "claude", authenticated: false, detail: "could not parse `claude auth status --json` output" });
      }
    });
  });
}

export function checkCodexAuthStatus(): Promise<AuthStatus> {
  return new Promise((resolve) => {
    const proc = spawn("codex", ["login", "status"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    proc.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    proc.once("error", () => resolve({ provider: "codex", authenticated: false, detail: "codex CLI was not found on PATH" }));
    proc.once("exit", (code) => {
      const authenticated = code === 0 && /logged in/i.test(stdout);
      resolve({ provider: "codex", authenticated, detail: authenticated ? stdout.trim() : "not authenticated (or codex login status exited non-zero)" });
    });
  });
}

/**
 * **Unverified-by-design**: Copilot CLI's own `--help` (checked live on
 * this machine, see docs/MULTI_AGENT.md) has no `status`/`whoami`
 * subcommand — only `login` (which performs a real OAuth flow, not a
 * read). There is no documented read-only way to answer "is this
 * already authenticated" without either reading `~/.copilot/` directly
 * (explicitly out of bounds, same rule as every other provider's
 * credential files) or attempting an action. Reports `unknown` honestly
 * rather than guessing from CLI presence alone.
 */
export function checkCopilotAuthStatus(): Promise<AuthStatus> {
  return new Promise((resolve) => {
    const proc = spawn("copilot", ["--version"], { stdio: "ignore" });
    proc.once("error", () => resolve({ provider: "copilot", authenticated: false, detail: "copilot CLI was not found on PATH" }));
    proc.once("exit", (code) => resolve({ provider: "copilot", authenticated: false, detail: code === 0 ? "copilot CLI found, but there is no documented read-only auth-status check — run `copilot login` interactively to confirm" : "copilot --version exited non-zero" }));
  });
}
