import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

test("build emits a fully resolved orchestration bundle", async () => {
  await execFileAsync(process.execPath, ["build.mjs"], {
    cwd: rootDir
  });

  const packageJson = JSON.parse(
    await readFile(path.join(rootDir, "package.json"), "utf8")
  );
  const outputPath = path.join(rootDir, "dist", "orchestration.html");
  const output = await readFile(outputPath, "utf8");

  assert.ok(output.length > 0);
  assert.match(output, new RegExp(packageJson.version.replace(/\./g, "\\.")));
  assert.doesNotMatch(output, /\{\{/);
});
