import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HandoffRecord, Task, WorkspaceLockRecord } from "./types.js";
import type { AutoTaskState } from "../auto/types.js";
import type { DesktopSessionRecord } from "../desktop/types.js";

/** `~/.agent-relay` by default; tests always pass an explicit temp dir so they never touch the real one. */
export function defaultStoreRoot(): string {
  return process.env.AGENT_RELAY_HOME ?? join(homedir(), ".agent-relay");
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path); // atomic on the same filesystem — this is the crash-safety property
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Durable, file-backed persistence for tasks, handoffs, and workspace
 * locks — one JSON file per record, written via write-temp-then-rename
 * so a crash mid-write never leaves a half-written file where a reader
 * could see it (rename is atomic on the same filesystem).
 */
export class HandoffStore {
  constructor(private readonly root: string = defaultStoreRoot()) {}

  private taskPath(taskId: string): string {
    return join(this.root, "tasks", `${taskId}.json`);
  }
  private handoffPath(handoffId: string): string {
    return join(this.root, "handoffs", `${handoffId}.json`);
  }
  private lockPath(lockKey: string): string {
    return join(this.root, "locks", `${lockKey}.json`);
  }
  private autoTaskPath(taskId: string): string {
    return join(this.root, "autotasks", `${taskId}.json`);
  }
  private desktopSessionPath(sessionId: string): string {
    return join(this.root, "desktop-sessions", `${encodeURIComponent(sessionId)}.json`);
  }

  async saveTask(task: Task): Promise<void> {
    await writeJsonAtomic(this.taskPath(task.taskId), task);
  }
  async loadTask(taskId: string): Promise<Task | null> {
    return readJson<Task>(this.taskPath(taskId));
  }
  async listTaskIds(): Promise<string[]> {
    return listJsonIds(join(this.root, "tasks"));
  }

  async saveHandoff(record: HandoffRecord): Promise<void> {
    await writeJsonAtomic(this.handoffPath(record.handoffId), record);
  }
  async loadHandoff(handoffId: string): Promise<HandoffRecord | null> {
    return readJson<HandoffRecord>(this.handoffPath(handoffId));
  }
  async listHandoffIds(): Promise<string[]> {
    return listJsonIds(join(this.root, "handoffs"));
  }

  async readLock(lockKey: string): Promise<WorkspaceLockRecord | null> {
    return readJson<WorkspaceLockRecord>(this.lockPath(lockKey));
  }
  async writeLock(record: WorkspaceLockRecord): Promise<void> {
    await writeJsonAtomic(this.lockPath(record.lockKey), record);
  }
  async deleteLock(lockKey: string): Promise<void> {
    await rm(this.lockPath(lockKey), { force: true });
  }

  /**
   * Atomic test-and-set: creates the lock file only if it does not
   * already exist, using `O_EXCL` (`flag: "wx"`). The filesystem
   * guarantees that of any two concurrent calls for the same `lockKey`,
   * at most one succeeds — this, not a read-then-write check, is what
   * makes `WorkspaceLockManager.acquire()` safe against two controllers
   * racing for a never-before-held workspace.
   */
  async createLockExclusive(record: WorkspaceLockRecord): Promise<boolean> {
    const path = this.lockPath(record.lockKey);
    await mkdir(join(path, ".."), { recursive: true });
    try {
      await writeFile(path, JSON.stringify(record, null, 2), { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  async saveAutoTask(state: AutoTaskState): Promise<void> {
    await writeJsonAtomic(this.autoTaskPath(state.taskId), state);
  }
  async loadAutoTask(taskId: string): Promise<AutoTaskState | null> {
    return readJson<AutoTaskState>(this.autoTaskPath(taskId));
  }
  async listAutoTaskIds(): Promise<string[]> {
    return listJsonIds(join(this.root, "autotasks"));
  }

  async saveDesktopSession(record: DesktopSessionRecord): Promise<void> {
    await writeJsonAtomic(this.desktopSessionPath(record.sessionId), record);
  }
  async loadDesktopSession(sessionId: string): Promise<DesktopSessionRecord | null> {
    return readJson<DesktopSessionRecord>(this.desktopSessionPath(sessionId));
  }
  async listDesktopSessionIds(): Promise<string[]> {
    return (await listJsonIds(join(this.root, "desktop-sessions"))).map((id) => decodeURIComponent(id));
  }
}

async function listJsonIds(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.includes(".tmp-")).map((f) => f.slice(0, -".json".length));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
