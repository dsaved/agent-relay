import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const FORBIDDEN_PATTERNS = [
  /ANTHROPIC_API_KEY/,
  /OPENAI_API_KEY/,
  /CODEX_ACCESS_TOKEN/,
  /@anthropic-ai\/sdk/,
  /openai["']?\s*\)/, // an `import ... from "openai"`-style SDK reference
  /process\.env\.[A-Z_]*API_KEY/,
];

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listTsFiles(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

test("no API-key authentication anywhere in src/: subscription auth only, as required by every phase so far", async () => {
  const files = await listTsFiles(join(process.cwd(), "src"));
  assert.ok(files.length > 20, "sanity check that the file scan actually found this project's sources");

  const offenders: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(content)) offenders.push(`${file}: matched ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
});
