import { test } from "node:test";
import assert from "node:assert/strict";
import { generateLaunchdPlist, plistPath, launchAgentsDir, DEFAULT_LAUNCHD_LABEL } from "../src/daemon/launchd.js";

test("generateLaunchdPlist: well-formed plist XML with the right ProgramArguments, RunAtLoad, and crash-only KeepAlive", () => {
  const xml = generateLaunchdPlist({ nodePath: "/usr/local/bin/node", cliPath: "/opt/agent-relay/dist/src/cli.js", stateDir: "/Users/test/.agent-relay" });

  assert.match(xml, /<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<key>Label<\/key>\s*<string>com\.agent-relay\.daemon<\/string>/);
  assert.match(xml, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(xml, /<string>\/opt\/agent-relay\/dist\/src\/cli\.js<\/string>/);
  assert.match(xml, /<string>daemon<\/string>/);
  assert.match(xml, /<string>run-foreground<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  // KeepAlive is scoped to a crash only (SuccessfulExit: false), not a blanket restart-always loop.
  assert.match(xml, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(xml, /launchd\.out\.log/);
  assert.match(xml, /launchd\.err\.log/);
});

test("generateLaunchdPlist: XML-escapes paths containing special characters", () => {
  const xml = generateLaunchdPlist({ nodePath: "/usr/local/bin/node", cliPath: "/opt/a&b<c>/cli.js", stateDir: "/tmp/x" });
  assert.match(xml, /a&amp;b&lt;c&gt;/);
  assert.doesNotMatch(xml, /a&b<c>/);
});

test("plistPath/launchAgentsDir point at ~/Library/LaunchAgents", () => {
  const path = plistPath();
  assert.match(path, /Library\/LaunchAgents/);
  assert.match(path, new RegExp(`${DEFAULT_LAUNCHD_LABEL}\\.plist$`));
  assert.ok(path.startsWith(launchAgentsDir()));
});

test("a custom label is reflected in both the plist content and plistPath()", () => {
  const xml = generateLaunchdPlist({ label: "com.example.custom", nodePath: "/node", cliPath: "/cli.js", stateDir: "/tmp" });
  assert.match(xml, /<string>com\.example\.custom<\/string>/);
  assert.match(plistPath("com.example.custom"), /com\.example\.custom\.plist$/);
});
