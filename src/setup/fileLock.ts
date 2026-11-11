import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPidAlive } from "../handoff/lock.js";

interface LockRecord {
  holderPid: number;
  holderToken: string;
  acquiredAt: number;
}

function lockPathFor(targetPath: string, lockDir: string): string {
  return join(lockDir, `${encodeURIComponent(targetPath)}.lock`);
}

export interface FileEditLock {
  release(): Promise<void>;
}

/**
 * Operational-hardening fix #1: two concurrent `setup`/`apply()` calls on
 * the *same* config file could otherwise both read "not present" and both
 * append, duplicating a hook. Reuses `WorkspaceLockManager`'s exact
 * safety property (`src/handoff/lock.ts`) — atomic `O_EXCL` create for a
 * never-before-held lock, and a dead holder's PID is the only thing that
 * lets a later caller reclaim it without an override — just generalized
 * to an arbitrary file path instead of a git workspace. A short poll
 * retry (there is no human "force" override here; this is pure internal
 * mutual exclusion, not a workspace-ownership decision).
 */
export async function acquireFileLock(targetPath: string, lockDir: string): Promise<FileEditLock> {
  const path = lockPathFor(targetPath, lockDir);
  await mkdir(lockDir, { recursive: true });
  const record: LockRecord = { holderPid: process.pid, holderToken: randomUUID(), acquiredAt: Date.now() };

  for (;;) {
    try {
      await writeFile(path, JSON.stringify(record), { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let existing: LockRecord | null = null;
      try {
        existing = JSON.parse(await readFile(path, "utf8")) as LockRecord;
      } catch {
        continue; // raced with the holder's own write/removal — just retry
      }
      if (!isPidAlive(existing.holderPid)) {
        await rm(path, { force: true }); // the prior holder's process is confirmed gone — safe to reclaim
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  return {
    release: async () => {
      try {
        const current = JSON.parse(await readFile(path, "utf8")) as LockRecord;
        if (current.holderToken === record.holderToken) await rm(path, { force: true });
      } catch {
        // already gone — nothing to release
      }
    },
  };
}

export async function withFileLock<T>(targetPath: string, lockDir: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireFileLock(targetPath, lockDir);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
