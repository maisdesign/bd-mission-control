import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function hasPowerShell() {
  const result = run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  return !result.error && result.status === 0;
}

function parseSnapshot(text) {
  const source = text.replace(/^\uFEFF/, '');
  const match = source.match(/^window\.BMC_SNAPSHOT\s*=\s*([\s\S]*?);\s*(?:window\.BMC_META\s*=\s*[\s\S]*?;\s*)?$/);
  assert.ok(match, 'snapshot JS format should be parseable');
  return JSON.parse(match[1]);
}

function readAndParse(filePath) {
  return parseSnapshot(readFileSync(filePath, 'utf8'));
}

test('refresh scripts generate equivalent snapshots', () => {
  const psOut = resolve(tmpdir(), 'bmc-test1.js');
  const shOut = resolve(tmpdir(), 'bmc-test2.js').replace(/\\/g, '/');
  const ps1 = hasPowerShell();

  if (ps1) {
    const ps = run('powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'scripts/refresh.ps1',
      '-Out',
      psOut,
    ]);
    assert.equal(ps.status, 0, ps.stderr);
  }

  const sh = run('sh', ['scripts/refresh.sh', '--out', shOut]);
  assert.equal(sh.status, 0, sh.stderr);

  const shSnapshot = readAndParse(shOut);
  assert.ok(shSnapshot.generated_at, 'sh output should include generated_at');
  assert.ok(Array.isArray(shSnapshot.issues), 'sh output should include issues');
  assert.ok(shSnapshot.issues.length > 0, 'sh output should include at least one issue');

  if (ps1) {
    const psSnapshot = readAndParse(psOut);
    assert.ok(psSnapshot.generated_at, 'ps output should include generated_at');
    assert.ok(Array.isArray(psSnapshot.issues), 'ps output should include issues');
    assert.ok(psSnapshot.issues.length > 0, 'ps output should include at least one issue');
    assert.equal(psSnapshot.issues.length, shSnapshot.issues.length, 'ps1 and sh outputs should match on issue count');
  }
});
