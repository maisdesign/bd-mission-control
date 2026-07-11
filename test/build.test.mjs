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

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

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

test("build outputs load optional sibling config/data scripts exactly once", async () => {
  await execFileAsync(process.execPath, ["build.mjs"], {
    cwd: rootDir
  });

  const outputPath = path.join(rootDir, "dist", "orchestration.html");
  const output = await readFile(outputPath, "utf8");

  assert.equal(
    countOccurrences(output, '<script src="orchestration.config.js"></script>'),
    1
  );
  assert.equal(
    countOccurrences(output, '<script src="orchestration-data.js"></script>'),
    1
  );
  const configTagIndex = output.indexOf('<script src="orchestration.config.js"></script>');
  const dataTagIndex = output.indexOf('<script src="orchestration-data.js"></script>');
  const lastInlineScriptIndex = output.lastIndexOf("<script>");
  assert.ok(configTagIndex < dataTagIndex);
  assert.ok(dataTagIndex < lastInlineScriptIndex);
});

test("demo build preserves optional sibling config/data scripts without duplication", async () => {
  await execFileAsync(process.execPath, ["build.mjs"], {
    cwd: rootDir
  });
  await execFileAsync(process.execPath, ["scripts/build-demo.mjs"], {
    cwd: rootDir
  });

  const output = await readFile(path.join(rootDir, "docs", "index.html"), "utf8");

  assert.equal(
    countOccurrences(output, '<script src="orchestration.config.js"></script>'),
    1
  );
  assert.equal(
    countOccurrences(output, '<script src="orchestration-data.js"></script>'),
    1
  );
});
