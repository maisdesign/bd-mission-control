import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, copyFile, lstat, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function hasPowerShell() {
  const result = run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  return !result.error && result.status === 0;
}

function toPosixPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.replace(/^([A-Za-z]):\//, '/$1/');
}

function posixJoin(...parts) {
  return parts
    .map((part, index) => {
      if (index === 0) {
        return String(part).replace(/\/+$/, '');
      }
      return String(part).replace(/^\/+|\/+$/g, '');
    })
    .filter((part) => part.length > 0)
    .join('/');
}

async function makeSourceTree() {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'bmc-install-source-'));
  await mkdir(join(sourceRoot, 'scripts'), { recursive: true });
  await mkdir(join(sourceRoot, 'dist'), { recursive: true });
  await copyFile(join(repoRoot, 'scripts', 'install.ps1'), join(sourceRoot, 'scripts', 'install.ps1'));
  await copyFile(join(repoRoot, 'scripts', 'install.sh'), join(sourceRoot, 'scripts', 'install.sh'));
  await copyFile(join(repoRoot, 'scripts', 'refresh.ps1'), join(sourceRoot, 'scripts', 'refresh.ps1'));
  await copyFile(join(repoRoot, 'scripts', 'refresh.sh'), join(sourceRoot, 'scripts', 'refresh.sh'));
  await copyFile(join(repoRoot, 'dist', 'orchestration.html'), join(sourceRoot, 'dist', 'orchestration.html'));
  return sourceRoot;
}

async function makeTargetProject(name) {
  const targetRoot = await mkdtemp(join(tmpdir(), name));
  await mkdir(join(targetRoot, '.beads'), { recursive: true });
  await writeFile(join(targetRoot, '.beads', 'issues.jsonl'), '{"id":"issue-1","title":"demo"}\n', 'utf8');
  return targetRoot;
}

async function readBytes(filePath) {
  return readFile(filePath);
}

async function canCreateDanglingSymlink() {
  const probeRoot = await mkdtemp(join(tmpdir(), 'bmc-install-symlink-probe-'));
  const linkPath = join(probeRoot, 'probe-link');
  try {
    await symlink('missing-target', linkPath, 'file');
    const stat = await lstat(linkPath);
    return stat.isSymbolicLink();
  } catch {
    return false;
  } finally {
    await unlink(linkPath).catch(() => {});
  }
}

function assertInstallSucceeded(result, context) {
  assert.equal(result.status, 0, `${context}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function assertInstallFailed(result, context) {
  assert.notEqual(result.status, 0, `${context}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function extractPanelVersion(text) {
  const match = text.match(/panel version v([0-9]+(?:\.[0-9]+)+)/i);
  assert.ok(match, 'expected panel version stamp in output');
  return match[1];
}

async function runPowerShellScenario() {
  if (!hasPowerShell()) {
    return;
  }

  const sourceRoot = await makeSourceTree();
  const targetRoot = await makeTargetProject('bmc-install-target-ps-');
  const panelDir = join(targetRoot, 'docs');
  const panelPath = join(panelDir, 'orchestration.html');
  const configPath = join(panelDir, 'orchestration.config.js');
  const scriptsDir = join(targetRoot, 'scripts');
  const refreshPs = join(scriptsDir, 'refresh.ps1');
  const refreshSh = join(scriptsDir, 'refresh.sh');
  const metaPath = join(panelDir, 'orchestration.meta.json');

  const install = run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(sourceRoot, 'scripts', 'install.ps1'),
    '-Target',
    targetRoot,
  ]);
  assertInstallSucceeded(install, 'install.ps1 fresh install failed');
  assert.match(install.stdout, /TAKY:/);
  assert.equal(extractPanelVersion(install.stdout), '0.1.0');
  assert.equal(await readBytes(panelPath).then((b) => b.length > 0), true);
  assert.equal(await readBytes(refreshPs).then((b) => b.length > 0), true);
  assert.equal(await readBytes(refreshSh).then((b) => b.length > 0), true);
  assert.equal(await readBytes(configPath).then((b) => b.length > 0), true);
  assert.equal(await readFile(configPath, 'utf8').then((text) => text.includes(`${basename(targetRoot)} mission control`)), true);
  assert.equal(await readFile(metaPath, 'utf8').catch(() => ''), '');

  const configBefore = await readBytes(configPath);
  await writeFile(configPath, `${await readFile(configPath, 'utf8')}\n// local edit`, 'utf8');
  const configEdited = await readBytes(configPath);
  const reinstall = run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(sourceRoot, 'scripts', 'install.ps1'),
    '-Target',
    targetRoot,
  ]);
  assertInstallSucceeded(reinstall, 'plain reinstall should preserve config');
  assert.deepEqual(await readBytes(configPath), configEdited);
  assert.notDeepEqual(configBefore, configEdited);

  const refreshBefore = await readBytes(refreshPs);
  await appendFile(refreshPs, Buffer.from('!'));
  const refreshEdited = await readBytes(refreshPs);
  const refreshRefused = run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(sourceRoot, 'scripts', 'install.ps1'),
    '-Target',
    targetRoot,
  ]);
  assertInstallFailed(refreshRefused, 'plain install should refuse a modified refresh.ps1');
  assert.deepEqual(await readBytes(refreshPs), refreshEdited);
  assert.notDeepEqual(refreshBefore, refreshEdited);

  const panelBefore = await readBytes(panelPath);
  await appendFile(panelPath, Buffer.from('!'));
  const modifiedPanel = await readBytes(panelPath);
  const refused = run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(sourceRoot, 'scripts', 'install.ps1'),
    '-Target',
    targetRoot,
  ]);
  assertInstallFailed(refused, 'plain install should refuse a modified panel');
  assert.deepEqual(await readBytes(panelPath), modifiedPanel);
  assert.notDeepEqual(panelBefore, modifiedPanel);
  assert.match(refused.stderr, /-Update/);

  const sourcePanelPath = join(sourceRoot, 'dist', 'orchestration.html');
  const sourcePanelBefore = await readBytes(sourcePanelPath);
  const updatedSource = Buffer.from(sourcePanelBefore.toString('utf8').replace('MISSION CONTROL HUD v0.1.0', 'MISSION CONTROL HUD v0.1.1'));
  await writeFile(sourcePanelPath, updatedSource);
  const updatedRun = run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(sourceRoot, 'scripts', 'install.ps1'),
    '-Target',
    targetRoot,
    '-Update',
  ]);
  assertInstallSucceeded(updatedRun, 'update install should replace the panel');
  assert.deepEqual(await readBytes(panelPath), updatedSource);
  assert.deepEqual(await readBytes(configPath), configEdited);
  assert.equal(await readFile(configPath, 'utf8').then((text) => text.includes(`${basename(targetRoot)} mission control`)), true);
}

async function runShScenario() {
  const sourceRoot = await makeSourceTree();
  const targetRoot = await makeTargetProject('bmc-install-target-sh-');
  const posixSourceRoot = toPosixPath(sourceRoot);
  const posixTargetRoot = toPosixPath(targetRoot);
  const panelDir = join(targetRoot, 'docs');
  const panelPath = join(panelDir, 'orchestration.html');
  const configPath = join(panelDir, 'orchestration.config.js');
  const scriptsDir = join(targetRoot, 'scripts');
  const refreshPs = join(scriptsDir, 'refresh.ps1');
  const refreshSh = join(scriptsDir, 'refresh.sh');

  const install = run('sh', [
    posixJoin(posixSourceRoot, 'scripts', 'install.sh'),
    '-Target',
    posixTargetRoot,
  ]);
  assertInstallSucceeded(install, 'install.sh fresh install failed');
  assert.match(install.stdout, /TAKY:/);
  assert.equal(extractPanelVersion(install.stdout), '0.1.0');
  assert.equal(await readBytes(panelPath).then((b) => b.length > 0), true);
  assert.equal(await readBytes(refreshPs).then((b) => b.length > 0), true);
  assert.equal(await readBytes(refreshSh).then((b) => b.length > 0), true);
  assert.equal(await readFile(configPath, 'utf8').then((text) => text.includes(`${basename(targetRoot)} mission control`)), true);

  const configBefore = await readBytes(configPath);
  await writeFile(configPath, `${await readFile(configPath, 'utf8')}\n// local edit`, 'utf8');
  const configEdited = await readBytes(configPath);
  const reinstall = run('sh', [
    posixJoin(posixSourceRoot, 'scripts', 'install.sh'),
    '-Target',
    posixTargetRoot,
  ]);
  assertInstallSucceeded(reinstall, 'plain reinstall should preserve config');
  assert.deepEqual(await readBytes(configPath), configEdited);
  assert.notDeepEqual(configBefore, configEdited);

  const refreshBefore = await readBytes(refreshSh);
  await appendFile(refreshSh, Buffer.from('!'));
  const refreshEdited = await readBytes(refreshSh);
  const refreshRefused = run('sh', [
    posixJoin(posixSourceRoot, 'scripts', 'install.sh'),
    '-Target',
    posixTargetRoot,
  ]);
  assertInstallFailed(refreshRefused, 'plain install should refuse a modified refresh.sh');
  assert.deepEqual(await readBytes(refreshSh), refreshEdited);
  assert.notDeepEqual(refreshBefore, refreshEdited);

  const panelBefore = await readBytes(panelPath);
  await appendFile(panelPath, Buffer.from('!'));
  const modifiedPanel = await readBytes(panelPath);
  const refused = run('sh', [
    posixJoin(posixSourceRoot, 'scripts', 'install.sh'),
    '-Target',
    posixTargetRoot,
  ]);
  assertInstallFailed(refused, 'plain install should refuse a modified panel');
  assert.deepEqual(await readBytes(panelPath), modifiedPanel);
  assert.notDeepEqual(panelBefore, modifiedPanel);
  assert.match(refused.stderr, /Update/);

  const sourcePanelPath = join(sourceRoot, 'dist', 'orchestration.html');
  const sourcePanelBefore = await readBytes(sourcePanelPath);
  const updatedSource = Buffer.from(sourcePanelBefore.toString('utf8').replace('MISSION CONTROL HUD v0.1.0', 'MISSION CONTROL HUD v0.1.1'));
  await writeFile(sourcePanelPath, updatedSource);
  const updatedRun = run('sh', [
    posixJoin(posixSourceRoot, 'scripts', 'install.sh'),
    '-Target',
    posixTargetRoot,
    '-Update',
  ]);
  assertInstallSucceeded(updatedRun, 'update install should replace the panel');
  assert.deepEqual(await readBytes(panelPath), updatedSource);
  assert.deepEqual(await readBytes(configPath), configEdited);
}

test('install scripts vendor the panel and preserve local config', async () => {
  await runPowerShellScenario();
  await runShScenario();
});

test('install scripts refuse a dangling symlink at orchestration.config.js', async (t) => {
  if (!(await canCreateDanglingSymlink())) {
    t.skip('dangling symlink creation is unavailable on this runner');
    return;
  }

  const sourceRoot = await makeSourceTree();
  const targetRoot = await makeTargetProject('bmc-install-symlink-config-');
  const panelDir = join(targetRoot, 'docs');
  const configPath = join(panelDir, 'orchestration.config.js');
  const symlinkTarget = join(targetRoot, 'missing-config-target.js');

  const ps = run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(sourceRoot, 'scripts', 'install.ps1'),
    '-Target',
    targetRoot,
  ]);
  assertInstallSucceeded(ps, 'initial install.ps1 failed before symlink test');
  await unlink(configPath);
  await symlink(symlinkTarget, configPath, 'file');
  const psRetry = run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(sourceRoot, 'scripts', 'install.ps1'),
    '-Target',
    targetRoot,
  ]);
  assertInstallFailed(psRetry, 'install.ps1 should refuse a dangling config symlink');
  assert.equal((await lstat(configPath)).isSymbolicLink(), true);

  const sourceRootSh = await makeSourceTree();
  const targetRootSh = await makeTargetProject('bmc-install-symlink-config-sh-');
  const panelDirSh = join(targetRootSh, 'docs');
  const configPathSh = join(panelDirSh, 'orchestration.config.js');
  const symlinkTargetSh = join(targetRootSh, 'missing-config-target.js');
  const sh = run('sh', [
    posixJoin(toPosixPath(sourceRootSh), 'scripts', 'install.sh'),
    '-Target',
    toPosixPath(targetRootSh),
  ]);
  assertInstallSucceeded(sh, 'initial install.sh failed before symlink test');
  await unlink(configPathSh);
  await symlink(symlinkTargetSh, configPathSh, 'file');
  const shRetry = run('sh', [
    posixJoin(toPosixPath(sourceRootSh), 'scripts', 'install.sh'),
    '-Target',
    toPosixPath(targetRootSh),
  ]);
  assertInstallFailed(shRetry, 'install.sh should refuse a dangling config symlink');
  assert.equal((await lstat(configPathSh)).isSymbolicLink(), true);
});

test('install scripts keep a literal glob-like -Dir segment', async () => {
  const sourceRoot = await makeSourceTree();
  const targetRoot = await makeTargetProject('bmc-install-glob-dir-');
  const runRoot = await mkdtemp(join(tmpdir(), 'bmc-install-glob-work-'));

  const panelDir = join(targetRoot, 'l[io]teral');
  const panelPath = join(panelDir, 'orchestration.html');
  const ps = run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(sourceRoot, 'scripts', 'install.ps1'),
    '-Target',
    targetRoot,
    '-Dir',
    'l[io]teral',
  ], { cwd: runRoot });
  assertInstallSucceeded(ps, 'install.ps1 should accept a literal glob-like -Dir segment');
  assert.equal(await readBytes(panelPath).then((b) => b.length > 0), true);

  const sourceRootSh = await makeSourceTree();
  const targetRootSh = await makeTargetProject('bmc-install-glob-dir-sh-');
  const panelDirSh = join(targetRootSh, 'l[io]teral');
  const panelPathSh = join(panelDirSh, 'orchestration.html');
  const sh = run('sh', [
    posixJoin(toPosixPath(sourceRootSh), 'scripts', 'install.sh'),
    '-Target',
    toPosixPath(targetRootSh),
    '-Dir',
    'l[io]teral',
  ], { cwd: runRoot });
  assertInstallSucceeded(sh, 'install.sh should accept a literal glob-like -Dir segment');
  assert.equal(await readBytes(panelPathSh).then((b) => b.length > 0), true);
});

test('install scripts refuse traversal outside the target root', async () => {
  const sourceRoot = await makeSourceTree();
  const targetRoot = await makeTargetProject('bmc-install-traversal-');
  const siblingEvil = join(dirname(targetRoot), 'evil');

  const psReady = hasPowerShell();
  if (psReady) {
    const ps = run('powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(sourceRoot, 'scripts', 'install.ps1'),
      '-Target',
      targetRoot,
      '-Dir',
      '../../evil',
    ]);
    assertInstallFailed(ps, 'install.ps1 traversal should be rejected');
    assert.equal(await readFile(siblingEvil, 'utf8').catch(() => ''), '');
  }

  const sh = run('sh', [
    posixJoin(toPosixPath(sourceRoot), 'scripts', 'install.sh'),
    '-Target',
    toPosixPath(targetRoot),
    '-Dir',
    '../../evil',
  ]);
  assertInstallFailed(sh, 'install.sh traversal should be rejected');
  assert.equal(await readFile(siblingEvil, 'utf8').catch(() => ''), '');
});
