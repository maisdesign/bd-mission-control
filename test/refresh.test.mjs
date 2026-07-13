import { readFile, mkdir, mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
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

function hasSh() {
  const result = run('sh', ['-c', 'exit 0']);
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

// Records every invocation (argv) to BD_STUB_RECORDER, then writes a marker
// issue to whatever path follows -o, so -AutoExport/--auto-export can be
// exercised end-to-end (including the exact args passed to bd) without a
// real Dolt/bd database.
const STUB_BD_SOURCE = `
import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const recorder = process.env.BD_STUB_RECORDER;
if (recorder) {
  appendFileSync(recorder, JSON.stringify(args) + '\\n', 'utf8');
}

function flagValue(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const outPath = flagValue('-o');
if (outPath) {
  writeFileSync(
    outPath,
    '{"id":"stub-exported","title":"stub bd export ran","status":"open","issue_type":"task"}\\n',
    'utf8'
  );
}
`;

async function writeStubBd(dir) {
  const stubScript = resolve(dir, 'stub-bd.mjs');
  await writeFile(stubScript, STUB_BD_SOURCE, 'utf8');

  // Windows (PowerShell): PATHEXT-resolved .cmd launcher.
  await writeFile(
    resolve(dir, 'bd.cmd'),
    '@echo off\r\nnode "%~dp0stub-bd.mjs" %*\r\n',
    'utf8'
  );

  // POSIX (sh): plain extensionless executable with a shebang.
  const shLauncher = resolve(dir, 'bd');
  await writeFile(shLauncher, '#!/bin/sh\nexec node "$(dirname "$0")/stub-bd.mjs" "$@"\n', 'utf8');
  await chmod(shLauncher, 0o755);
}

async function readRecordedInvocations(recorderPath) {
  if (!existsSync(recorderPath)) {
    return [];
  }
  const text = await awaitableRead(recorderPath);
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function flagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : null;
}

// Windows can expose the same directory under both its long name and an 8.3
// short name (e.g. TEMP resolving to `...\MARCOC~1\...` while PowerShell's
// own GetFullPath returns `...\MarcoCardia\...`) — resolve through the real
// filesystem entry so path comparisons aren't tripped up by that, not just
// string-normalize.
function canonicalPath(p) {
  // realpathSync's default (JS-based) implementation does not resolve
  // Windows 8.3 short names (e.g. `MARCOC~1`) to their long form; .native
  // (the real OS syscall) does.
  return realpathSync.native(resolve(p));
}

test('refresh scripts generate equivalent string-payload snapshots', async () => {
  const psOut = makeTempPath('bmc-refresh-a3-ps.js');
  const shOut = posixPath(makeTempPath('bmc-refresh-a3-sh.js'));
  const ps1 = hasPowerShell();
  const sh1 = hasSh();

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

  if (sh1) {
    const sh = run('sh', ['scripts/refresh.sh', '--out', shOut, '--no-bd-enrich']);
    assert.equal(sh.status, 0, sh.stderr);

    const shText = await awaitableRead(shOut);
    const shSnapshot = parseSnapshot(shText);
    const shIssues = extractIssues(shSnapshot);
    const shSource = normalizeSourcePath(shSnapshot.source);

    assert.equal(shSnapshot.generated_at.length > 0, true);
    assert.equal(shSource.endsWith('/.beads/issues.jsonl'), true);
    // live tracker export: the count grows with the project — assert non-empty, not a snapshot-in-time number
    assert.equal(shIssues.length > 0, true);
    assert.match(shText, /\\u[0-9a-fA-F]{4}/);
    assert.doesNotMatch(shText, /\u0001/);

    if (ps1) {
      const psText = await awaitableRead(psOut);
      const psSnapshot = parseSnapshot(psText);
      const psIssues = extractIssues(psSnapshot);
      const psSource = normalizeSourcePath(psSnapshot.source);

      assert.equal(psSnapshot.generated_at.length > 0, true);
      assert.equal(psSource, shSource);
      assert.equal(psIssues.length > 0, true);
      assert.equal(psIssues.length, shIssues.length);
      assert.match(psText, /\\u[0-9a-fA-F]{4}/);
      assert.doesNotMatch(psText, /\u0001/);
    }
  } else if (ps1) {
    const psText = await awaitableRead(psOut);
    const psSnapshot = parseSnapshot(psText);
    const psIssues = extractIssues(psSnapshot);
    const psSource = normalizeSourcePath(psSnapshot.source);

    assert.equal(psSnapshot.generated_at.length > 0, true);
    assert.equal(psSource.endsWith('/.beads/issues.jsonl'), true);
    assert.equal(psIssues.length > 0, true);
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
  const sh1 = hasSh();

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

    const generated = await awaitableRead(outPath);
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
  }

  if (sh1) {
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
  }
});

test('-AutoExport / --auto-export resolves -BeadsDir to the correct .beads location and project context', async () => {
  // Regression test: an earlier version of -AutoExport/--auto-export treated
  // an explicit -BeadsDir value as the export directory verbatim, without
  // replicating Find-IssuesPathFromBeadsDir's/find_issues_in_dir's existing
  // dual meaning (either the .beads folder itself, or a project root
  // containing .beads). That wrote a stray issues.jsonl at the project root
  // instead of inside .beads, and ran `bd export` from the ambient cwd
  // instead of the resolved project, so an explicit -BeadsDir for a
  // different project could silently export the wrong project's data. Both
  // are checked here via a stub `bd` that records its exact argv.
  const ps1 = hasPowerShell();
  const sh1 = hasSh();

  const stubDir = await mkdtemp(join(tmpdir(), 'bmc-stub-bd-'));
  await writeStubBd(stubDir);

  async function runProjectRootCase(label, beadsDirValue, expectSubdir) {
    const projectRoot = await mkdtemp(join(tmpdir(), `bmc-autoexport-${label}-`));
    const beadsSubdir = join(projectRoot, '.beads');
    await mkdir(beadsSubdir, { recursive: true });
    // Seed a stale issue so a successful stub export (which overwrites this
    // file) is distinguishable from just re-reading what was already there.
    await writeFile(
      join(beadsSubdir, 'issues.jsonl'),
      '{"id":"stale","title":"stale","status":"open","issue_type":"task"}\n',
      'utf8'
    );

    const recorderPath = join(projectRoot, 'invocations.jsonl');
    const outPath = join(projectRoot, 'snapshot-out.js');
    const target = beadsDirValue === 'root' ? projectRoot : beadsSubdir;

    return { projectRoot, beadsSubdir, recorderPath, outPath, target, expectSubdir };
  }

  if (ps1) {
    for (const [label, mode] of [['ps-root', 'root'], ['ps-beadsdir', 'beadsdir']]) {
      const c = await runProjectRootCase(label, mode);
      const env = {
        ...process.env,
        PATH: stubDir + ';' + process.env.PATH,
        BD_STUB_RECORDER: c.recorderPath,
      };

      const result = run(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          'scripts/refresh.ps1',
          '-BeadsDir',
          c.target,
          '-Out',
          c.outPath,
          '-NoBdEnrich',
          '-AutoExport',
        ],
        { env }
      );
      assert.equal(result.status, 0, result.stderr);

      const invocations = await readRecordedInvocations(c.recorderPath);
      assert.equal(invocations.length, 1, 'bd should be invoked exactly once');
      const argv = invocations[0];
      assert.equal(
        canonicalPath(flagValue(argv, '-o')),
        canonicalPath(join(c.beadsSubdir, 'issues.jsonl')),
        `[${label}] bd export -o should target .beads/issues.jsonl, not a stray root-level file`
      );
      assert.equal(
        canonicalPath(flagValue(argv, '-C')),
        canonicalPath(c.projectRoot),
        `[${label}] bd -C should scope to the resolved project dir, not the ambient cwd`
      );

      assert.equal(
        existsSync(join(c.projectRoot, 'issues.jsonl')),
        false,
        `[${label}] no stray issues.jsonl should be created at the project root`
      );

      const generated = await awaitableRead(c.outPath);
      const snapshot = parseSnapshot(generated);
      assert.match(
        snapshot.issues_jsonl,
        /stub-exported/,
        `[${label}] snapshot should reflect the freshly (stub-)exported file, not the stale seed`
      );
    }
  }

  if (sh1) {
    for (const [label, mode] of [['sh-root', 'root'], ['sh-beadsdir', 'beadsdir']]) {
      const c = await runProjectRootCase(label, mode);
      const env = {
        ...process.env,
        PATH: stubDir + ':' + process.env.PATH,
        BD_STUB_RECORDER: c.recorderPath,
      };

      const result = run(
        'sh',
        [
          'scripts/refresh.sh',
          '--beads-dir',
          posixPath(c.target),
          '--out',
          posixPath(c.outPath),
          '--no-bd-enrich',
          '--auto-export',
        ],
        { env }
      );
      assert.equal(result.status, 0, result.stderr);

      const invocations = await readRecordedInvocations(c.recorderPath);
      assert.equal(invocations.length, 1, 'bd should be invoked exactly once');
      const argv = invocations[0];
      assert.equal(
        canonicalPath(flagValue(argv, '-o')),
        canonicalPath(join(c.beadsSubdir, 'issues.jsonl')),
        `[${label}] bd export -o should target .beads/issues.jsonl, not a stray root-level file`
      );
      assert.equal(
        canonicalPath(flagValue(argv, '-C')),
        canonicalPath(c.projectRoot),
        `[${label}] bd -C should scope to the resolved project dir, not the ambient cwd`
      );

      assert.equal(
        existsSync(join(c.projectRoot, 'issues.jsonl')),
        false,
        `[${label}] no stray issues.jsonl should be created at the project root`
      );

      const generated = await awaitableRead(c.outPath);
      const snapshot = parseSnapshot(generated);
      assert.match(
        snapshot.issues_jsonl,
        /stub-exported/,
        `[${label}] snapshot should reflect the freshly (stub-)exported file, not the stale seed`
      );
    }
  }
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
