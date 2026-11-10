import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { DEFAULT_CONFIG, configPath, loadConfig, saveConfig } from "../src/daemon/config.js";
import { withTempStoreRoot } from "./helpers/tempHandoffEnv.js";

test("loadConfig: absent file is not an error — just the defaults", async () => {
  await withTempStoreRoot(async (stateDir) => {
    const { config, error } = await loadConfig(stateDir);
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.equal(error, undefined);
  });
});

test("saveConfig/loadConfig round-trip, merging over defaults for any field left unset", async () => {
  await withTempStoreRoot(async (stateDir) => {
    await saveConfig(stateDir, { ...DEFAULT_CONFIG, maxConcurrentTasks: 1, registeredProjects: ["/tmp/a"] });
    const { config } = await loadConfig(stateDir);
    assert.equal(config.maxConcurrentTasks, 1);
    assert.deepEqual(config.registeredProjects, ["/tmp/a"]);
    assert.equal(config.logRetentionDays, DEFAULT_CONFIG.logRetentionDays);
  });
});

test("loadConfig: malformed JSON is reported, never thrown, and falls back to defaults", async () => {
  await withTempStoreRoot(async (stateDir) => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(configPath(stateDir), "{not json");
    const { config, error } = await loadConfig(stateDir);
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.match(error ?? "", /not valid JSON/);
  });
});

test("the config type has no field anywhere for a password, token, or API key", () => {
  const keys = Object.keys(DEFAULT_CONFIG);
  for (const key of keys) assert.doesNotMatch(key, /token|secret|password|api[_-]?key/i, `unexpected credential-shaped field: ${key}`);
});
