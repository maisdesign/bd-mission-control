import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { parseJSONL, deriveModel } from '../src/engine.mjs';

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
  const match = source.match(/^window\.BMC_SNAPSHOT\s*=\s*([\s\S]*?);\s*(?:window\.BMC_META_JSON\s*=\s*[\s\S]*?;\s*)?$/);
  assert.ok(match, 'snapshot JS format should be parseable');
  return JSON.parse(match[1]);
}

async function awaitableRead(filePath) {
  return readFile(filePath, 'utf8');
}

function extractIssues(snapshot) {
  assert.equal(typeof snapshot.issues_jsonl, 'string', 'snapshot should carry issues_jsonl');
  return parseJSONL(snapshot.issues_jsonl);
}

function makeTempPath(name) {
  return resolve(tmpdir(), name);
}

function posixPath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function normalizeSourcePath(filePath) {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);
}

test('refresh scripts generate equivalent string-payload snapshots', async () => {
  const psOut = makeTempPath('bmc-refresh-a3-ps.js');
  const shOut = posixPath(makeTempPath('bmc-refresh-a3-sh.js'));
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
      '-NoBdEnrich',
    ]);
    assert.equal(ps.status, 0, ps.stderr);
  }

  const sh = run('sh', ['scripts/refresh.sh', '--out', shOut, '--no-bd-enrich']);
  assert.equal(sh.status, 0, sh.stderr);

  const shText = await awaitableRead(shOut);
  const shSnapshot = parseSnapshot(shText);
  const shIssues = extractIssues(shSnapshot);
  const shSource = normalizeSourcePath(shSnapshot.source);

  assert.equal(shSnapshot.generated_at.length > 0, true);
  assert.equal(shSource.endsWith('/.beads/issues.jsonl'), true);
  assert.equal(shIssues.length, 11);
  assert.match(shText, /\\u[0-9a-fA-F]{4}/);
  assert.doesNotMatch(shText, /\u0001/);

  if (ps1) {
    const psText = await awaitableRead(psOut);
    const psSnapshot = parseSnapshot(psText);
    const psIssues = extractIssues(psSnapshot);
    const psSource = normalizeSourcePath(psSnapshot.source);

    assert.equal(psSnapshot.generated_at.length > 0, true);
    assert.equal(psSource, shSource);
    assert.equal(psIssues.length, 11);
    assert.equal(psIssues.length, shIssues.length);
    assert.match(psText, /\\u[0-9a-fA-F]{4}/);
    assert.doesNotMatch(psText, /\u0001/);
  }
});

test('refresh scripts keep malicious JSONL inert when evaluated', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'bmc-refresh-adversarial-'));
  const beadsDir = join(tempRoot, '.beads');
  const outDir = join(tempRoot, 'out');
  const outPath = join(outDir, 'snapshot.js');
  const metaPath = join(outDir, 'orchestration.meta.json');
  await mkdir(beadsDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const attackLine = '{"a":1}};alert(document.cookie);({"b":2}';
  const controlLine = '{"id":"ctrl","title":"A\u0001B","status":"open","issue_type":"task","description":"first line\\nsecond line"}';
  await writeFile(join(beadsDir, 'issues.jsonl'), `${controlLine}\n${attackLine}\n`, 'utf8');
  await writeFile(metaPath, '\uFEFF{"waves":{"demo":{"title":"Demo","subtitle":"Multi-line\\nmeta","order":1}}}', 'utf8');

  const ps1 = hasPowerShell();
  if (ps1) {
    const ps = run('powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'scripts/refresh.ps1',
      '-BeadsDir',
      beadsDir,
      '-Out',
      outPath,
      '-NoBdEnrich',
    ]);
    assert.equal(ps.status, 0, ps.stderr);
  }

  const shOut = posixPath(join(outDir, 'snapshot-sh.js'));
  const sh = run('sh', [
    'scripts/refresh.sh',
    '--beads-dir',
    posixPath(beadsDir),
    '--out',
    shOut,
    '--no-bd-enrich',
  ]);
  assert.equal(sh.status, 0, sh.stderr);

  const generated = await awaitableRead(shOut);
  let alertCalled = false;
  const context = {
    window: {},
    document: undefined,
    console: { info() {}, error() {} },
    alert() {
      alertCalled = true;
    },
  };

  vm.runInNewContext(generated, context, { timeout: 1000 });

  assert.equal(alertCalled, false);
  assert.equal(context.window.BMC_SNAPSHOT.issues_jsonl.includes(attackLine), true);
  assert.equal(context.window.BMC_SNAPSHOT.issues_jsonl.includes('\u0001'), true);
  assert.equal(JSON.parse(context.window.BMC_META_JSON).waves.demo.subtitle, 'Multi-line\nmeta');
});

test('panel snapshot resolution accepts both issue payload shapes', async () => {
  const panelSource = await readFile(resolve('src', 'panel.js'), 'utf8');

  const legacyContext = {
    window: {
      BMC_SNAPSHOT: {
        issues: [
          { id: 'legacy-1', status: 'open', issue_type: 'task' },
        ],
      },
      BMC_META: {
        waves: {
          demo: { title: 'Legacy demo' },
        },
      },
    },
    console: { info() {}, error() {} },
    parseJSONL,
    deriveModel,
  };
  legacyContext.globalThis = legacyContext;

  vm.runInNewContext(panelSource, legacyContext, { timeout: 1000 });
  assert.equal(legacyContext.window.BMC_RUNTIME.issues.length, 1);
  assert.equal(legacyContext.window.BMC_RUNTIME.meta.waves.demo.title, 'Legacy demo');

  const newShapeContext = {
    window: {
      BMC_SNAPSHOT: {
        issues_jsonl: '{"id":"new-1","status":"open","issue_type":"task"}\n{"id":"new-2","status":"closed","issue_type":"task"}\n',
      },
      BMC_META_JSON: '{"waves":{"demo":{"title":"JSON demo"}}}',
      BMC_META: {
        waves: {
          demo: { title: 'Should be replaced' },
        },
      },
    },
    console: { info() {}, error() {} },
    parseJSONL,
    deriveModel,
  };
  newShapeContext.globalThis = newShapeContext;

  vm.runInNewContext(panelSource, newShapeContext, { timeout: 1000 });
  assert.equal(newShapeContext.window.BMC_RUNTIME.issues.length, 2);
  assert.equal(newShapeContext.window.BMC_RUNTIME.meta.waves.demo.title, 'JSON demo');

  const fallbackInfos = [];
  const fallbackContext = {
    window: {
      BMC_SNAPSHOT: {
        issues_jsonl: '{"id":"fallback-1","status":"open","issue_type":"task"}\n',
      },
      BMC_META_JSON: '{not valid json',
      BMC_META: {
        waves: {
          demo: { title: 'Fallback demo' },
        },
      },
    },
    console: {
      info(...args) {
        fallbackInfos.push(args.join(' '));
      },
      error() {},
    },
    parseJSONL,
    deriveModel,
  };
  fallbackContext.globalThis = fallbackContext;

  vm.runInNewContext(panelSource, fallbackContext, { timeout: 1000 });
  assert.equal(fallbackContext.window.BMC_RUNTIME.issues.length, 1);
  assert.equal(fallbackContext.window.BMC_RUNTIME.meta.waves.demo.title, 'Fallback demo');
  assert.equal(fallbackInfos.length > 0, true);
});
