import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEnvironment } from "../src/setup/environment.js";

test("checkEnvironment: macOS + a satisfying node version", () => {
  const env = checkEnvironment(22, "darwin", "v22.5.0");
  assert.equal(env.isMacOS, true);
  assert.equal(env.nodeVersionSupported, true);
  assert.equal(env.nodeMajor, 22);
});

test("checkEnvironment: non-macOS is reported, not treated as an error", () => {
  const env = checkEnvironment(22, "linux", "v22.5.0");
  assert.equal(env.isMacOS, false);
  assert.match(env.detail, /launchd activation is macOS-only/);
});

test("checkEnvironment: an older node version is flagged as unsupported", () => {
  const env = checkEnvironment(22, "darwin", "v18.19.0");
  assert.equal(env.nodeVersionSupported, false);
  assert.match(env.detail, /older than the required/);
});
