import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function assertPublicDemoPayload(text) {
  const match = text.match(/^window\.BMC_SNAPSHOT = ([\s\S]*);\s*$/);
  assert.ok(match, "demo snapshot must contain a JSON payload");
  const snapshot = JSON.parse(match[1]);
  assert.equal(snapshot.source, "demo/issues.jsonl");
  assert.equal(Object.hasOwn(snapshot, "orchestrator"), false);
  assert.doesNotMatch(text, /bmc-/i);
  assert.doesNotMatch(text, /@/);
  assert.equal(typeof snapshot.issues_jsonl, "string");
  const issues = snapshot.issues_jsonl.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.ok(issues.length > 0);
  for (const issue of issues) {
    assert.ok(issue.id.startsWith("demo-"), `non-demo issue: ${issue.id}`);
  }
  const checkKeys = value => {
    if (value && typeof value === "object") {
      assert.equal(Object.hasOwn(value, "orchestrator"), false);
      Object.values(value).forEach(checkKeys);
    }
  };
  checkKeys(snapshot);
  checkKeys(issues);
}

test("committed demo snapshot contains only public fixture data", async () => {
  assertPublicDemoPayload(await readFile(path.join(rootDir, "docs", "orchestration-data.js"), "utf8"));
});

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

test("demo build is public, reproducible, and preserves sibling scripts without duplication", async () => {
  await execFileAsync(process.execPath, ["build.mjs"], {
    cwd: rootDir
  });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bmc-demo-"));
  try {
    await execFileAsync(process.execPath, ["scripts/build-demo.mjs"], {
      cwd: rootDir,
      env: { ...process.env, BMC_DEMO_OUT_DIR: tmpDir }
    });

    const output = await readFile(path.join(tmpDir, "index.html"), "utf8");

    assert.equal(
      countOccurrences(output, '<script src="orchestration.config.js"></script>'),
      1
    );
    assert.equal(
      countOccurrences(output, '<script src="orchestration-data.js"></script>'),
      1
    );

    const artifacts = ["orchestration-data.js", "orchestration.config.js", "index.html"];
    const firstRun = await Promise.all(artifacts.map(file => readFile(path.join(tmpDir, file), "utf8")));
    assertPublicDemoPayload(firstRun[0]);
    await execFileAsync(process.execPath, ["scripts/build-demo.mjs"], {
      cwd: rootDir,
      env: { ...process.env, BMC_DEMO_OUT_DIR: tmpDir }
    });
    for (const [index, file] of artifacts.entries()) {
      const secondRun = await readFile(path.join(tmpDir, file), "utf8");
      const committed = await readFile(path.join(rootDir, "docs", file), "utf8");
      assert.equal(secondRun, firstRun[index], `${file} must be byte-identical across builds`);
      assert.equal(secondRun.replace(/\r\n/g, "\n"), committed.replace(/\r\n/g, "\n"), `${file} must match docs/`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
