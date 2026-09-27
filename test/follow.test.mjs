import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { follow, optionsFromArgs, supportedVersion } from '../scripts/follow.mjs';

const helper = fileURLToPath(new URL('../scripts/follow.mjs', import.meta.url));
const bd = process.env.BMC_BD;
const real = { skip: !bd && 'set BMC_BD to a bd >= 1.3.0 binary', timeout: 60000 };

async function until(predicate, detail, timeout = 15000) {
  const end = Date.now() + timeout;
  do {
    if (await predicate()) return;
    await delay(25);
  } while (Date.now() < end);
  assert.fail(`timed out: ${typeof detail === 'function' ? detail() : detail}`);
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'bmc-follow-'));
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
  const beadsDir = join(root, '.beads');
  const checkpoint = join(root, 'checkpoint.json');
  await mkdir(beadsDir);
  return { root, beadsDir, checkpoint, bd: 'mock-bd', debounceMs: 20, cleanups };
}

async function textOrMissing(path) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function seqAt(path) {
  const text = await textOrMissing(path);
  return text === undefined ? undefined : JSON.parse(text).seq;
}

// Stream doubles exercise the real follower, export scheduling, filesystem
// checkpoints and teardown. Actual bd data changes are tested separately below.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.closed = false;
  child.signals = [];
  child.finish = (code = 0, signal = null) => {
    if (child.closed) return;
    child.closed = true;
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit('close', code, signal));
  };
  child.kill = signal => {
    child.signals.push(signal);
    child.finish(null, signal);
    return true;
  };
  return child;
}

function mock(t, options, overrides = {}) {
  const calls = [];
  const logs = [];
  const live = [];
  const signals = new EventEmitter();
  const spawnChild = (binary, args, spawnOptions) => {
    const child = fakeChild();
    const call = { binary, args, spawnOptions, child };
    calls.push(call);
    setImmediate(() => {
      if (child.closed) return;
      if (overrides.handle?.(call)) return;
      if (args[0] === 'version') child.stdout.write(`bd version ${overrides.version ?? '1.3.0'}\n`);
      else if (args[0] === 'config') child.stdout.write(`${overrides.journal ?? 'true'}\n`);
      else if (args[0] === 'events') {
        if (args.includes('--follow')) {
          live.push(child);
          return;
        }
        if (overrides.head) child.stdout.write(`${JSON.stringify({ seq: overrides.head })}\n`);
      }
      child.finish();
    });
    return child;
  };
  const result = follow(options, { spawnChild, log: line => logs.push(line), signals });
  options.cleanups.push(async () => {
    signals.emit('SIGTERM');
    await result;
    assert.ok(calls.every(call => call.child.closed), 'no child left alive');
  });
  return { calls, logs, live, result, signals };
}

test('CLI defaults, paths, version floor and invalid inputs', () => {
  const options = optionsFromArgs(['--beads-dir', 'sample/.beads', '--checkpoint', 'checkpoint']);
  assert.equal(options.debounceMs, 300);
  assert.equal(options.bd, 'bd');
  assert.equal(options.beadsDir, resolve('sample/.beads'));
  assert.equal(options.checkpoint, resolve('checkpoint'));
  assert.equal(optionsFromArgs(['--help']), null);
  for (const version of ['1.3.0', '1.3.1', '1.4.0', '2.0.0']) assert.ok(supportedVersion(`bd version ${version}`));
  for (const version of ['1.1.0', '1.2.99', '0.9.0', '1.3.0-rc.1', 'unknown']) assert.ok(!supportedVersion(version));
  for (const args of [[], ['--unknown'], ['--beads-dir', 'x', '--checkpoint', 'c', '--debounce-ms', '-1'],
    ['--beads-dir', 'x', '--checkpoint', 'c', '--debounce-ms', 'NaN'],
    ['--beads-dir', 'x', '--checkpoint', 'c', '--debounce-ms', '2147483648'],
    ['--beads-dir', 'x', '--checkpoint', 'x/issues.jsonl']]) assert.throws(() => optionsFromArgs(args));
});

for (const [name, overrides, exit, message] of [
  ['old bd', { version: '1.1.0' }, 3, /1\.3\.0/],
  ['disabled journal', { journal: 'false' }, 4, /events-journal/],
]) {
  test(`${name} leaves existing export and checkpoint byte-for-byte unchanged`, async t => {
    const options = await workspace(t);
    const issues = join(options.beadsDir, 'issues.jsonl');
    await writeFile(issues, 'existing issues\n');
    await writeFile(options.checkpoint, '{"seq":7}\n');
    const run = mock(t, options, overrides);
    assert.equal(await run.result, exit);
    assert.match(run.logs.join('\n'), message);
    assert.equal(await textOrMissing(issues), 'existing issues\n');
    assert.equal(await textOrMissing(options.checkpoint), '{"seq":7}\n');
    assert.ok(run.calls.every(c => ['version', 'config'].includes(c.args[0])));
  });
  test(`${name} does not create an export or checkpoint`, async t => {
    const options = await workspace(t);
    assert.equal(await mock(t, options, overrides).result, exit);
    assert.equal(await textOrMissing(join(options.beadsDir, 'issues.jsonl')), undefined);
    assert.equal(await textOrMissing(options.checkpoint), undefined);
  });
}

test('initial rebuild captures head before export, uses workspace cwd and refresh flags', async t => {
  const options = await workspace(t);
  options.out = join(options.root, 'snapshot.js');
  const run = mock(t, options, { head: 9 });
  await until(() => run.live.length, 'follower started');
  assert.deepEqual(run.logs, ['bmc-follow: start since=0', 'bmc-follow: rebuild reason=initial', 'bmc-follow: exported seq=9']);
  assert.equal(await seqAt(options.checkpoint), 9);
  assert.ok(run.calls.every(c => c.spawnOptions.cwd === options.root));
  assert.deepEqual(run.calls.find(c => c.args[0] === 'export').args, ['export', '-o', join(options.beadsDir, 'issues.jsonl')]);
  const refresh = run.calls.find(c => c.binary !== options.bd);
  assert.equal(refresh.binary, process.platform === 'win32' ? 'pwsh' : 'sh');
  assert.deepEqual(refresh.args, process.platform === 'win32'
    ? ['-NoProfile', '-File', join(dirname(helper), 'refresh.ps1'), '-BeadsDir', options.beadsDir, '-NoBdEnrich', '-Out', options.out]
    : [join(dirname(helper), 'refresh.sh'), '--beads-dir', options.beadsDir, '--no-bd-enrich', '--out', options.out]);
  assert.deepEqual(run.calls.at(-1).args, ['events', 'tail', '--since', '9', '--follow', '--json']);
  assert.ok(!(await readdir(options.root)).some(name => name.endsWith('.tmp')));
});

test('debounced fragmented JSONL and concurrent events cannot advance a pending export', async t => {
  const options = await workspace(t);
  await writeFile(options.checkpoint, '{"seq":1}\n');
  const exports = [];
  const run = mock(t, options, { head: 1, handle: call => {
    if (call.args[0] !== 'export') return false;
    exports.push(call.child);
    return true;
  } });
  await until(() => run.live.length, 'follower started');
  run.live[0].stdout.write('{"se');
  run.live[0].stdout.write('q":2}\r\n{"seq":3}\n');
  await until(() => exports.length === 1, 'first batched export');
  assert.equal(await seqAt(options.checkpoint), 1);
  run.live[0].stdout.write('{"seq":4}\n');
  exports[0].finish();
  await until(() => exports.length === 2, 'export of concurrent event');
  assert.equal(await seqAt(options.checkpoint), 3);
  exports[1].finish();
  await until(async () => await seqAt(options.checkpoint) === 4, 'final checkpoint');
  assert.equal(exports.length, 2);
  assert.deepEqual(run.logs, ['bmc-follow: start since=1', 'bmc-follow: exported seq=3', 'bmc-follow: exported seq=4']);
});

for (const stage of ['export', 'refresh']) {
  test(`${stage} failure preserves checkpoint and stops the follower`, async t => {
    const options = await workspace(t);
    await writeFile(options.checkpoint, '{"seq":2}\n');
    if (stage === 'refresh') options.out = join(options.root, 'snapshot.js');
    const run = mock(t, options, { head: 2, handle: call => {
      if (!(stage === 'export' ? call.args[0] === 'export' : call.binary !== options.bd)) return false;
      call.child.stderr.write('controlled failure');
      call.child.finish(1);
      return true;
    } });
    await until(() => run.live.length, 'follower started');
    run.live[0].stdout.write('{"seq":3}\n');
    assert.equal(await run.result, 1);
    assert.equal(await seqAt(options.checkpoint), 2);
    assert.ok(run.live[0].closed);
    assert.ok(!run.logs.some(line => line.includes('exported seq=')));
  });
}

test('truncation rebuilds from error head and keeps following', async t => {
  const options = await workspace(t);
  await writeFile(options.checkpoint, '{"seq":2}\n');
  const run = mock(t, options, { handle: call => {
    if (call.args[0] !== 'events' || call.args.includes('9')) return false;
    call.child.stdout.write(`${JSON.stringify({ code: 'events_journal_truncated', floor: 8, head: 9 }, null, 2)}\n`);
    call.child.finish(1);
    return true;
  } });
  await until(() => run.live.length, 'following after rebuild');
  assert.equal(await seqAt(options.checkpoint), 9);
  assert.ok(run.logs.includes('bmc-follow: rebuild reason=truncated'));
  run.live[0].stdout.write('{"seq":10}\n');
  await until(async () => await seqAt(options.checkpoint) === 10, 'post-rebuild export');
});

test('a checkpoint above head triggers replica-reset, even for an empty journal', async t => {
  const options = await workspace(t);
  await writeFile(options.checkpoint, '{"seq":100}\n');
  const run = mock(t, options);
  await until(() => run.live.length, 'following empty replica');
  assert.equal(await seqAt(options.checkpoint), 0);
  assert.deepEqual(run.logs, ['bmc-follow: start since=100', 'bmc-follow: rebuild reason=replica-reset', 'bmc-follow: exported seq=0']);
});

test('malformed journal records fail without advancing checkpoint', async t => {
  const options = await workspace(t);
  await writeFile(options.checkpoint, '{"seq":1}\n');
  const run = mock(t, options, { head: 1 });
  await until(() => run.live.length, 'follower started');
  run.live[0].stdout.write('{broken}\n');
  assert.equal(await run.result, 1);
  assert.equal(await seqAt(options.checkpoint), 1);
});

test('unexpected successful tail exit is an error, not a silent stalled follower', async t => {
  const options = await workspace(t);
  const run = mock(t, options);
  await until(() => run.live.length, 'follower started');
  run.live[0].finish();
  assert.equal(await run.result, 1);
  assert.match(run.logs.at(-1), /stopped unexpectedly/);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} stops the bd child and exits 0 with unexported events replayable`, async t => {
    const options = await workspace(t);
    options.debounceMs = 1000;
    const run = mock(t, options);
    await until(() => run.live.length, 'follower started');
    run.live[0].stdout.write('{"seq":1}\n');
    run.signals.emit(signal);
    assert.equal(await run.result, 0);
    assert.ok(run.live[0].signals.includes('SIGTERM'));
    assert.equal(await seqAt(options.checkpoint), 0);
  });
}

test('shutdown escalates if a child ignores SIGTERM', async t => {
  const options = await workspace(t);
  const run = mock(t, options);
  await until(() => run.live.length, 'follower started');
  const child = run.live[0];
  const kill = child.kill;
  child.kill = signal => signal === 'SIGTERM' ? true : kill(signal);
  run.signals.emit('SIGTERM');
  assert.equal(await run.result, 0);
  assert.deepEqual(child.signals, ['SIGKILL']);
});

function command(root, binary, args) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${binary} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

async function realWorkspace(t, journal = true) {
  const options = await workspace(t);
  command(options.root, 'git', ['init', '-q']);
  command(options.root, bd, ['init', '--non-interactive', '--prefix', 't', '--skip-agents', '-q']);
  if (journal) command(options.root, bd, ['config', 'set', 'events-journal', 'true']);
  const invoke = (...args) => command(options.root, bd, args);
  return { ...options, bd, invoke };
}

function launch(t, options, extra = []) {
  // Launch from outside the bd workspace to prove --beads-dir scopes commands.
  const child = spawn(process.execPath, [helper, '--beads-dir', options.beadsDir,
    '--checkpoint', options.checkpoint, '--bd', bd, '--debounce-ms', '50', ...extra], {
    cwd: dirname(helper), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const closed = new Promise((resolveClosed, reject) => {
    child.on('error', reject);
    child.once('close', code => resolveClosed(code));
  });
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        // Windows has no POSIX SIGKILL delivery; terminate the entire tree.
        const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        assert.ifError(result.error);
      } else process.kill(-child.pid, 'SIGKILL');
    }
    await closed;
  };
  options.cleanups.push(kill);
  return { child, closed, kill, stderr: () => stderr };
}

async function issueStatus(options, id) {
  const text = await textOrMissing(join(options.beadsDir, 'issues.jsonl'));
  if (!text) return undefined;
  try { return text.trim().split('\n').map(line => JSON.parse(line)).find(issue => issue.id === id)?.status; }
  catch { return undefined; } // Export may currently be replacing the file.
}

test('real bd: close updates JSONL and snapshot without a later write; restart replays downtime', real, async t => {
  const options = await realWorkspace(t);
  const id = JSON.parse(options.invoke('create', 'live test', '--json')).id;
  const out = join(options.root, 'snapshot with spaces', 'orchestration-data.js');
  const first = launch(t, options, ['--out', out]);
  await until(async () => (await seqAt(options.checkpoint)) > 0, first.stderr);
  assert.equal(await issueStatus(options, id), 'open');
  options.invoke('close', id);
  await until(async () => await issueStatus(options, id) === 'closed', 'close visible', 5000);
  await until(async () => {
    const text = await textOrMissing(out);
    if (!text) return false;
    const snapshot = JSON.parse(text.slice('window.BMC_SNAPSHOT = '.length).replace(/;\s*$/, ''));
    assert.equal(snapshot.orchestrator, undefined);
    return JSON.parse(snapshot.issues_jsonl.trim()).status === 'closed';
  }, 'snapshot reflects close');
  await until(async () => (await seqAt(options.checkpoint)) >= 2, 'close checkpoint');
  await first.kill();
  const saved = await seqAt(options.checkpoint);
  const secondId = JSON.parse(options.invoke('create', 'created while down', '--json')).id;
  const second = launch(t, options);
  await until(async () => (await seqAt(options.checkpoint)) > saved, 'downtime replay');
  assert.equal(await issueStatus(options, secondId), 'open');
  assert.ok(second.stderr().includes(`bmc-follow: start since=${saved}`));
  assert.ok(!second.stderr().includes('rebuild reason='));
});

test('real bd: pruned history rebuilds and continues following', real, async t => {
  const options = await realWorkspace(t);
  options.invoke('config', 'set', 'events-journal-retain-days', '0');
  options.invoke('config', 'set', 'events-journal-retain-rows', '0');
  const id = JSON.parse(options.invoke('create', 'pruned test', '--json')).id;
  options.invoke('update', id, '--title', 'updated');
  options.invoke('close', id);
  const records = options.invoke('events', 'tail', '--since', '0', '--json').trim().split('\n').map(JSON.parse);
  const head = records.at(-1).seq;
  options.invoke('events', 'prune', '--before', String(head));
  await writeFile(options.checkpoint, '{"seq":1}\n');
  const run = launch(t, options);
  await until(async () => await seqAt(options.checkpoint) === head, 'truncated rebuild');
  assert.ok(run.stderr().includes('bmc-follow: rebuild reason=truncated'));
  assert.equal(await issueStatus(options, id), 'closed');
  options.invoke('reopen', id);
  await until(async () => (await seqAt(options.checkpoint)) > head, 'following after truncation');
  assert.equal(await issueStatus(options, id), 'open');
});

test('real bd: foreign checkpoint above head rebuilds from current replica', real, async t => {
  const options = await realWorkspace(t);
  const id = JSON.parse(options.invoke('create', 'replica test', '--json')).id;
  await writeFile(options.checkpoint, '{"seq":99999}\n');
  const run = launch(t, options);
  await until(async () => await seqAt(options.checkpoint) === 1, 'replica-reset checkpoint');
  assert.equal(await issueStatus(options, id), 'open');
  assert.ok(run.stderr().includes('bmc-follow: rebuild reason=replica-reset'));
});

test('real bd: journal-off exit 4 preserves export and checkpoint', real, async t => {
  const options = await realWorkspace(t, false);
  options.invoke('create', 'journal disabled');
  const issues = join(options.beadsDir, 'issues.jsonl');
  const before = await textOrMissing(issues);
  await writeFile(options.checkpoint, '{"seq":42}\n');
  const run = launch(t, options);
  assert.equal(await run.closed, 4);
  assert.match(run.stderr(), /events-journal/);
  assert.equal(await textOrMissing(issues), before);
  assert.equal(await textOrMissing(options.checkpoint), '{"seq":42}\n');
});
