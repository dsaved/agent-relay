import { spawn } from "node:child_process";
import type { ValidationCommandResult } from "./types.js";

function runOne(command: string, cwd: string): Promise<ValidationCommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, { cwd, shell: true, stdio: "ignore" });
    proc.once("error", () => resolve({ command, exitCode: null, passed: false }));
    proc.once("exit", (code) => resolve({ command, exitCode: code, passed: code === 0 }));
  });
}

/**
 * Runs exactly the commands the caller explicitly configured — never
 * commands this engine guesses at (e.g. it does not run `npm test` on
 * its own initiative). Per the task's own completion criteria,
 * "report completion only when the required validation criteria pass":
 * this stops at the first failure rather than running every command
 * regardless, since there's no reason to keep validating a task that's
 * already failed.
 */
export async function runValidationCommands(cwd: string, commands: string[]): Promise<ValidationCommandResult[]> {
  const results: ValidationCommandResult[] = [];
  for (const command of commands) {
    const result = await runOne(command, cwd);
    results.push(result);
    if (!result.passed) break;
  }
  return results;
}
