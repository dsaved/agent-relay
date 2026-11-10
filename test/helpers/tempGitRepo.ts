import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * A disposable git repo in the OS temp dir, outside any real user
 * project, torn down after `run` returns or throws. The path is
 * resolved through `realpath` before `run` sees it: on macOS,
 * `os.tmpdir()` returns a `/var/...` path that's a symlink to
 * `/private/var/...`, and `git rev-parse --show-toplevel` (correctly)
 * reports the resolved form — so tests comparing against the raw
 * `mkdtemp` result would spuriously fail on a difference this helper,
 * not the code under test, is responsible for not leaking.
 */
export async function withTempRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await realpath(await mkdtemp(join(tmpdir(), "agent-relay-test-")));
  try {
    git(["init", "-q"], repoRoot);
    git(["config", "user.email", "test@test.local"], repoRoot);
    git(["config", "user.name", "test"], repoRoot);
    await writeFile(join(repoRoot, "README.md"), "hello\n");
    git(["add", "."], repoRoot);
    git(["commit", "-q", "-m", "init"], repoRoot);
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}
