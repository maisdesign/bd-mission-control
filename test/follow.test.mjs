import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { follow, optionsFromArgs, supportedVersion } from '../scripts/follow.mjs';

const helper = fileURLToPath(new URL('../scripts/follow.mjs', import.meta.url));
const bd = process.env.BMC_BD;
const real = { skip: !bd && 'set BMC_BD to a bd >= 1.3.0 binary', timeout: 60000 };
// Collection and detached flushing are separate switches in bd 1.3.0.
// Scope both to test children; never change the user's saved metrics settings.
const testEnv = { ...process.env, BD_DISABLE_METRICS: '1', BD_DISABLE_EVENT_FLUSH: '1' };

async function until(predicate, detail, timeout = 15000) {
  const end = Date.now() + timeout;
  do {
    if (await predicate()) return;
    await delay(25);
  } while (Date.now() < end);
  assert.fail(`timed out: ${typeof detail === 'function' ? detail() : detail}`);
}

function workspacePids(root, timeout, ancestors = []) {
  const windows = process.platform === 'win32';
  // Pass the path in the environment so the query itself cannot match it.
  const script = `
    $ErrorActionPreference = 'Stop'
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
      $_.ProcessId -ne $PID -and $_.ProcessId -ne ${process.pid}
    })
    $tracked = [Collections.Generic.HashSet[int]]::new()
    $ancestors = @($env:BMC_FOLLOW_PARENTS | ConvertFrom-Json)
    foreach ($p in $processes) {
      $created = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()
      foreach ($a in $ancestors) {
        if (($p.ProcessId -eq $a.pid -or $p.ParentProcessId -eq $a.pid) -and
            $created -ge $a.start -and $created -le $a.end) { [void]$tracked.Add([int]$p.ProcessId) }
      }
    }
    do {
      $added = $false
      foreach ($p in $processes) {
        if ($tracked.Contains([int]$p.ParentProcessId) -or ($p.CommandLine -and
            $p.CommandLine.IndexOf($env:BMC_FOLLOW_WORKSPACE, [StringComparison]::OrdinalIgnoreCase) -ge 0)) {
          if ($tracked.Add([int]$p.ProcessId)) { $added = $true }
        }
      }
    } while ($added)
    ConvertTo-Json -Compress -InputObject @($processes | Where-Object {
      $tracked.Contains([int]$_.ProcessId)
    } | ForEach-Object { [int]$_.ProcessId })
  `;
  const result = spawnSync(windows ? 'powershell.exe' : 'ps', windows
    ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    : ['-A', '-o', 'pid=', '-o', 'args='], {
    encoding: 'utf8', windowsHide: true, timeout,
    env: { ...process.env, BMC_FOLLOW_WORKSPACE: root, BMC_FOLLOW_PARENTS: JSON.stringify(ancestors) },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `workspace process query failed: ${result.stderr}`);
  if (windows) return JSON.parse(result.stdout.trim());
  return result.stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    return match && Number(match[1]) !== process.pid && match[2].includes(root) ? [Number(match[1])] : [];
  });
}

async function waitForWorkspaceExit(root, deadline = Date.now() + 5000, ancestors = []) {
  deadline = Math.min(deadline, Date.now() + 5000);
  let pids = [];
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try { pids = workspacePids(root, remaining, ancestors); }
    catch (error) {
      throw new Error(`cannot verify process exit for ${root}; last leftover PIDs: ${pids.join(', ') || 'unknown'}`, { cause: error });
    }
    if (!pids.length) return;
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  assert.fail(`workspace processes still alive at cleanup deadline: ${root}; leftover PIDs: ${pids.join(', ')}`);
}

async function clearReadonly(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await clearReadonly(path);
    else if (entry.isFile()) await chmod(path, 0o666);
  }
}

async function removeWorkspace(root, { remove = rm, wait = delay, deadline = Date.now() + 9000, now = Date.now } = {}) {
  async function removeTree(path) {
    // rimraf tries rmdir before visiting children; Windows can report EBUSY
    // there and leave the entire tree untouched. Empty directories first.
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await removeTree(child);
      else await remove(child, { force: true, maxRetries: 0 });
    }
    await remove(path, { recursive: true, force: true, maxRetries: 0 });
  }
  for (let attempt = 0; ; attempt++) {
    try {
      if (process.platform === 'win32') await clearReadonly(root);
      await removeTree(root);
      return;
    } catch (error) {
      if (error.code === 'ENOENT' && error.path === root) return;
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE'].includes(error.code) || attempt === 8) throw error;
      // One budget shared by the entire tree, not a new budget at each level.
      const remaining = deadline - now();
      if (remaining <= 0) throw error;
      await wait(Math.min(200 * (attempt + 1), remaining));
      if (now() >= deadline) throw error;
    }
  }
}

async function workspace(t, realProcesses = false) {
  const root = await mkdtemp(join(tmpdir(), 'bmc-follow-'));
  const cleanups = [];
  const pids = [];
  t.after(async () => {
    // Stop, process verification and removal share one wall-clock budget.
    const deadline = Date.now() + 9000;
    const errors = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(deadline); } catch (error) { errors.push(error); }
    }
    try {
      if (realProcesses) await waitForWorkspaceExit(root, deadline, pids);
      await removeWorkspace(root, { deadline });
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, `workspace cleanup failed: ${errors.map(error => error.message).join('; ')}`);
  });
  const beadsDir = join(root, '.beads');
  const checkpoint = join(root, 'checkpoint.json');
  await mkdir(beadsDir);
  return { root, beadsDir, checkpoint, bd: 'mock-bd', debounceMs: 20, cleanups, pids };
}

test('workspace teardown removes nested read-only git object files', async t => {
  const options = await workspace(t);
  const objects = join(options.root, '.git', 'objects', 'ab');
  await mkdir(objects, { recursive: true });
  const object = join(objects, 'readonly-object');
  await writeFile(object, 'test object');
  await chmod(object, 0o444);
  // Hooks run in registration order, so inspect after workspace()'s cleanup.
  t.after(async () => assert.rejects(readdir(options.root), { code: 'ENOENT' }));
});

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
  const signals = overrides.signals ?? new EventEmitter();
  const stdin = new PassThrough();
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
  const result = follow(options, {
    spawnChild, log: line => logs.push(line), signals, stdin, renameCheckpoint: overrides.renameCheckpoint,
  });
  options.cleanups.push(async () => {
    signals.emit('SIGTERM');
    await result;
    assert.ok(calls.every(call => call.child.closed), 'no child left alive');
  });
  return { calls, logs, live, result, signals, stdin };
}

test('CLI defaults, paths, version floor and invalid inputs', () => {
  const options = optionsFromArgs(['--beads-dir', 'sample/.beads', '--checkpoint', 'checkpoint']);
  assert.equal(options.debounceMs, 300);
  assert.equal(options.bd, 'bd');
  assert.equal(options.beadsDir, resolve('sample/.beads'));
  assert.equal(options.checkpoint, resolve('checkpoint'));
  assert.equal(options.stopOnStdinEof, false);
  assert.equal(optionsFromArgs(['--beads-dir', 'sample/.beads', '--checkpoint', 'checkpoint', '--stop-on-stdin-eof']).stopOnStdinEof, true);
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

test('Windows checkpoint replacement retries sharing violations without removing the saved checkpoint', async t => {
  const options = await workspace(t);
  await writeFile(options.checkpoint, '{"seq":1}\n');
  let attempts = 0;
  const run = mock(t, options, { head: 1, renameCheckpoint: async (source, destination) => {
    attempts++;
    assert.equal(await seqAt(destination), 1, 'old checkpoint must remain readable until replacement');
    if (process.platform === 'win32' && attempts <= 2) {
      throw Object.assign(new Error('sharing violation'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
    }
    return rename(source, destination);
  } });
  await until(() => run.live.length, 'follower started');
  run.live[0].stdout.write('{"seq":2}\n');
  await until(async () => await seqAt(options.checkpoint) === 2, 'checkpoint replaced');
  // The real filesystem may add sharing violations beyond the two injected.
  if (process.platform === 'win32') assert.ok(attempts >= 3 && attempts <= 9, `rename attempts: ${attempts}`);
  else assert.equal(attempts, 1);
  assert.ok(!(await readdir(options.root)).some(name => name.endsWith('.tmp')));
});

test('persistent checkpoint replacement failure preserves saved sequence and stops every child', async t => {
  const options = await workspace(t);
  await writeFile(options.checkpoint, '{"seq":1}\n');
  let attempts = 0;
  const run = mock(t, options, { head: 1, renameCheckpoint: async () => {
    attempts++;
    throw Object.assign(new Error('persistent sharing violation'), { code: 'EPERM' });
  } });
  await until(() => run.live.length, 'follower started');
  run.live[0].stdout.write('{"seq":2}\n');
  assert.equal(await run.result, 1);
  assert.equal(attempts, process.platform === 'win32' ? 9 : 1);
  assert.equal(await seqAt(options.checkpoint), 1);
  assert.ok(run.calls.every(call => call.child.closed));
  assert.ok(!(await readdir(options.root)).some(name => name.endsWith('.tmp')));
});

test('initial rebuild captures head before export, uses workspace cwd and refresh flags', async t => {
  const options = await workspace(t);
  options.out = join(options.root, 'snapshot.js');
  const run = mock(t, options, { head: 9 });
  await until(() => run.live.length, 'follower started');
  assert.deepEqual(run.logs, ['bmc-follow: start since=0', 'bmc-follow: rebuild reason=initial', 'bmc-follow: exported seq=9']);
  assert.equal(await seqAt(options.checkpoint), 9);
  assert.ok(run.calls.every(c => c.spawnOptions.cwd === options.root));
  assert.ok(run.calls.filter(c => c.binary === options.bd)
    .every(c => c.spawnOptions.env.BD_DISABLE_EVENT_FLUSH === '1'));
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

function ipcSignals(connected = true) {
  const signals = new EventEmitter();
  signals.send = () => {};
  signals.connected = connected;
  signals.disconnect = () => {
    signals.connected = false;
    signals.emit('disconnect');
  };
  return signals;
}

function requestStop(run, source) {
  if (source === 'IPC message') run.signals.emit('message', { type: 'stop' });
  else if (source === 'IPC disconnect') run.signals.disconnect();
  else if (source === 'stdin EOF') run.stdin.end();
  else run.signals.emit(source);
}

for (const source of ['SIGINT', 'SIGTERM', 'IPC message', 'IPC disconnect', 'stdin EOF']) {
  test(`${source} stops the bd child and exits 0 with unexported events replayable`, async t => {
    const options = await workspace(t);
    options.debounceMs = 1000;
    options.stopOnStdinEof = source === 'stdin EOF';
    const run = mock(t, options, { signals: source.startsWith('IPC') ? ipcSignals() : undefined });
    await until(() => run.live.length, 'follower started');
    run.live[0].stdout.write('{"seq":1}\n');
    requestStop(run, source);
    assert.equal(await run.result, 0);
    assert.ok(run.live[0].signals.includes('SIGTERM'));
    assert.equal(await seqAt(options.checkpoint), 0);
    for (const event of ['SIGINT', 'SIGTERM', 'message', 'disconnect']) assert.equal(run.signals.listenerCount(event), 0);
    assert.equal(run.stdin.listenerCount('end'), 0);
    assert.notEqual(run.stdin.readableFlowing, true);
  });
}

for (const source of ['IPC message', 'IPC disconnect', 'stdin EOF']) {
  test(`${source} waits for both the tail and an in-flight export to close`, async t => {
    const options = await workspace(t);
    await writeFile(options.checkpoint, '{"seq":1}\n');
    options.stopOnStdinEof = source === 'stdin EOF';
    let exporting;
    const run = mock(t, options, { head: 1, signals: ipcSignals(), handle: call => {
      if (call.args[0] !== 'export') return false;
      exporting = call.child;
      return true;
    } });
    await until(() => run.live.length, 'follower started');
    run.live[0].stdout.write('{"seq":2}\n');
    await until(() => exporting, 'export started');
    // Keep both close events under test control after stop requests termination.
    for (const child of [run.live[0], exporting]) child.kill = signal => { child.signals.push(signal); return true; };
    let settled = false;
    run.result.then(() => { settled = true; });
    requestStop(run, source);
    await until(() => exporting.signals.length && run.live[0].signals.length, 'both children asked to stop');
    run.live[0].finish(null, 'SIGTERM');
    await new Promise(resolveImmediate => setImmediate(resolveImmediate));
    assert.equal(settled, false, 'export has not closed yet');
    exporting.finish(null, 'SIGTERM');
    assert.equal(await run.result, 0);
    assert.equal(await seqAt(options.checkpoint), 1);
  });
}

test('IPC loss before startup stops without spawning a child', async t => {
  const options = await workspace(t);
  const run = mock(t, options, { signals: ipcSignals(false) });
  assert.equal(await run.result, 0);
  assert.equal(run.calls.length, 0);
});

test('unrelated IPC messages and stdin EOF without the flag do not stop following', async t => {
  const options = await workspace(t);
  const run = mock(t, options, { signals: ipcSignals() });
  await until(() => run.live.length, 'follower started');
  for (const message of [null, 'stop', {}, { type: 'status' }]) run.signals.emit('message', message);
  run.stdin.resume();
  run.stdin.end();
  run.live[0].stdout.write('{"seq":1}\n');
  await until(async () => await seqAt(options.checkpoint) === 1, 'still exporting');
  assert.equal(run.live[0].closed, false);
});

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

function command(options, binary, args) {
  const start = Date.now();
  const result = spawnSync(binary, args, {
    cwd: options.root, env: testEnv, encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  // Bound ancestry by command lifetime to exclude recycled Windows PIDs.
  if (result.pid) options.pids.push({ pid: result.pid, start, end: Date.now() });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${binary} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

async function realWorkspace(t, journal = true) {
  const options = await workspace(t, true);
  command(options, 'git', ['init', '-q']);
  command(options, bd, ['init', '--non-interactive', '--prefix', 't', '--skip-agents', '-q']);
  if (journal) command(options, bd, ['config', 'set', 'events-journal', 'true']);
  const invoke = (...args) => command(options, bd, args);
  return { ...options, bd, invoke };
}

async function closesWithin(closed, timeout = 5000) {
  let timer;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(false), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

function childCompletion(child) {
  // Node 24.18 can miss ChildProcess 'close' after parent-side disconnect():
  // its IPC close counter is advanced on EOF, but not on explicit disconnect.
  // Observe each public event instead; exit alone would hide inherited pipes.
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  const streams = [child.stdin, child.stdout, child.stderr].filter(Boolean)
    .map(stream => new Promise(resolveClose => stream.once('close', resolveClose)));
  const ipc = child.connected
    ? new Promise(resolveDisconnect => child.once('disconnect', resolveDisconnect)) : undefined;
  return Promise.all([exited, ...streams, ipc]).then(([code]) => code);
}

test('child completion waits for output streams after exit and IPC disconnect', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.connected = true;
  let completed = false;
  const completion = childCompletion(child).then(code => { completed = true; return code; });
  child.emit('disconnect');
  child.emit('exit', 0);
  child.stdout.emit('close');
  await new Promise(resolveImmediate => setImmediate(resolveImmediate));
  assert.equal(completed, false, 'stderr must close too');
  child.stderr.emit('close');
  assert.equal(await completion, 0);
});

test('workspace removal shares one linear retry budget across different files', async t => {
  const options = await workspace(t);
  await writeFile(join(options.root, 'a'), 'a');
  await writeFile(join(options.root, 'b'), 'b');
  const failures = new Set([join(options.root, 'a'), join(options.root, 'b')]);
  const waits = [];
  await removeWorkspace(options.root, {
    remove: async (path, settings) => {
      if (failures.delete(path)) throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
      return rm(path, settings);
    },
    wait: async ms => { waits.push(ms); },
  });
  assert.deepEqual(waits, [200, 400]);
  await assert.rejects(readdir(options.root), { code: 'ENOENT' });
});

test('workspace removal fails after a total 7.2 s retry budget', async t => {
  const options = await workspace(t);
  const waits = [];
  let attempts = 0;
  await assert.rejects(removeWorkspace(options.root, {
    remove: async () => {
      attempts++;
      throw Object.assign(new Error('persistent lock'), { code: 'EBUSY' });
    },
    wait: async ms => { waits.push(ms); },
  }), { code: 'EBUSY' });
  assert.equal(attempts, 9);
  assert.deepEqual(waits, [200, 400, 600, 800, 1000, 1200, 1400, 1600]);
});

test('empty workspace root locks use only the teardown budget remaining after process exit', async t => {
  const options = await workspace(t);
  const waits = [];
  let clock = 0;
  let attempts = 0;
  await assert.rejects(removeWorkspace(options.root, {
    deadline: 750, now: () => clock,
    remove: async (path, settings) => {
      if (path !== options.root) return rm(path, settings);
      assert.deepEqual(await readdir(path), [], 'only the empty root is locked');
      attempts++;
      throw Object.assign(new Error('persistent root lock'), { code: 'EBUSY', path });
    },
    wait: async ms => { waits.push(ms); clock += ms; },
  }), { code: 'EBUSY', path: options.root });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [200, 400, 150]);
  assert.equal(clock, 750);
});

test('Windows teardown reports a cwd-only descendant of an exited command by PID', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const options = await workspace(t, true);
  // Like bd send-metrics: detached child, inherited cwd, no workspace in argv.
  const leakedPid = Number(command(options, process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore', windowsHide: true });
    console.log(child.pid);
    child.unref();
  `]));
  options.cleanups.push(() => {
    try { process.kill(leakedPid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  });
  assert.ok(workspacePids(options.root, 5000, options.pids).includes(leakedPid));
  await assert.rejects(waitForWorkspaceExit(options.root, Date.now() + 1500, options.pids),
    error => error.message.includes(`leftover PIDs: ${leakedPid}`));
});

test('real Node child completes after parent disconnects IPC', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, ['-e', `
    process.on('disconnect', () => {
      process.stdout.write('stopped\\n');
      process.stderr.write('drained\\n');
    });
    process.send({ type: 'ready' });
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const completion = childCompletion(child);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    assert.ok(await closesWithin(completion), 'fixture must exit and close its streams');
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  await new Promise((resolveReady, reject) => {
    child.once('message', resolveReady);
    child.once('error', reject);
  });
  child.disconnect();
  assert.ok(await closesWithin(completion), 'parent disconnect must not lose completion');
  assert.equal(await completion, 0);
  assert.equal(stdout, 'stopped\n');
  assert.equal(stderr, 'drained\n');
});

function launch(t, options, extra = [], stopVia = 'message') {
  const start = Date.now();
  // Launch from outside the bd workspace to prove --beads-dir scopes commands.
  const child = spawn(process.execPath, [helper, '--beads-dir', options.beadsDir,
    '--checkpoint', options.checkpoint, '--bd', bd, '--debounce-ms', '50',
    ...(stopVia === 'stdin' ? ['--stop-on-stdin-eof'] : []), ...extra], {
    cwd: dirname(helper), env: testEnv, windowsHide: true, detached: process.platform !== 'win32',
    stdio: stopVia === 'stdin' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const lifetime = { pid: child.pid, start, end: Number.MAX_SAFE_INTEGER };
  options.pids.push(lifetime);
  let stderr = '';
  child.stdout.resume();
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  let childError;
  child.on('error', error => { childError = error; });
  child.stdin?.on('error', error => { childError = error; });
  const closed = childCompletion(child);
  closed.then(() => { lifetime.end = Date.now(); });
  let stopJob;
  const stop = (deadline = Date.now() + 9000) => stopJob ??= (async () => {
    const remaining = () => Math.max(0, deadline - Date.now());
    const running = child.exitCode === null && child.signalCode === null;
    if (running) {
      if (stopVia === 'stdin') child.stdin.end();
      else if (child.connected) {
        if (stopVia === 'disconnect') child.disconnect();
        else child.send({ type: 'stop' }, error => { if (error) childError = error; });
      }
    }
    if (!await closesWithin(closed, Math.min(5000, remaining()))) {
      let fallback = '';
      if (process.platform === 'win32') {
        const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, encoding: 'utf8', timeout: Math.max(1, Math.min(1000, remaining())),
        });
        fallback = result.error?.message ?? `taskkill exit=${result.status}: ${result.stderr}`;
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { fallback = error.message; }
      }
      const reaped = await closesWithin(closed, remaining());
      assert.fail(`helper PID ${child.pid} did not stop gracefully before teardown deadline; forced kill attempted; closed=${reaped}; ${fallback}\n${stderr}`);
    }
    assert.ifError(childError);
    if (running) assert.equal(await closed, 0, `graceful stop failed\n${stderr}`);
  })();
  options.cleanups.push(stop);
  return { child, closed, stop, stderr: () => stderr };
}

async function issueStatus(options, id) {
  const text = await textOrMissing(join(options.beadsDir, 'issues.jsonl'));
  if (!text) return undefined;
  try { return text.trim().split('\n').map(line => JSON.parse(line)).find(issue => issue.id === id)?.status; }
  catch { return undefined; } // Export may currently be replacing the file.
}

test('real bd: close updates JSONL and snapshot without a later write; restart replays downtime', real, async t => {
  const options = await realWorkspace(t);
  assert.match(options.invoke('metrics'), /^Anonymous usage metrics: OFF/m);
  const id = JSON.parse(options.invoke('create', 'live test', '--json')).id;
  const out = join(options.root, 'snapshot with spaces', 'orchestration-data.js');
  const first = launch(t, options, ['--out', out]);
  await until(async () => (await seqAt(options.checkpoint)) > 0, first.stderr);
  assert.equal(await issueStatus(options, id), 'open');
  options.invoke('close', id);
  await until(async () => await issueStatus(options, id) === 'closed', () => `close visible\n${first.stderr()}`, 5000);
  await until(async () => {
    const text = await textOrMissing(out);
    if (!text) return false;
    const snapshot = JSON.parse(text.slice('window.BMC_SNAPSHOT = '.length).replace(/;\s*$/, ''));
    assert.equal(snapshot.orchestrator, undefined);
    return JSON.parse(snapshot.issues_jsonl.trim()).status === 'closed';
  }, () => `snapshot reflects close\n${first.stderr()}`);
  await until(async () => (await seqAt(options.checkpoint)) >= 2, () => `close checkpoint\n${first.stderr()}`);
  await first.stop();
  const saved = await seqAt(options.checkpoint);
  const secondId = JSON.parse(options.invoke('create', 'created while down', '--json')).id;
  const second = launch(t, options, [], 'disconnect');
  await until(async () => (await seqAt(options.checkpoint)) > saved, () => `downtime replay\n${second.stderr()}`);
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
  const run = launch(t, options, [], 'stdin');
  await until(async () => await seqAt(options.checkpoint) === head, () => `truncated rebuild\n${run.stderr()}`);
  assert.ok(run.stderr().includes('bmc-follow: rebuild reason=truncated'));
  assert.equal(await issueStatus(options, id), 'closed');
  options.invoke('reopen', id);
  await until(async () => (await seqAt(options.checkpoint)) > head, () => `following after truncation\n${run.stderr()}`);
  assert.equal(await issueStatus(options, id), 'open');
});

test('real bd: foreign checkpoint above head rebuilds from current replica', real, async t => {
  const options = await realWorkspace(t);
  const id = JSON.parse(options.invoke('create', 'replica test', '--json')).id;
  await writeFile(options.checkpoint, '{"seq":99999}\n');
  const run = launch(t, options);
  await until(async () => await seqAt(options.checkpoint) === 1, () => `replica-reset checkpoint\n${run.stderr()}`);
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
