#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const usage = 'Usage: node scripts/follow.mjs --beads-dir <path/to/.beads> --checkpoint <file> [--bd <binary>] [--out <file>] [--debounce-ms <n>] [--stop-on-stdin-eof]\n--stop-on-stdin-eof requires piped stdin; a TTY is rejected with exit 1.';
const exportGraceMs = 2000;
const childKillMs = 1000;
const childCloseMs = 1500;
const staleStagingMs = 10 * 60 * 1000;

export function optionsFromArgs(args) {
  const { values } = parseArgs({ args, options: {
    'beads-dir': { type: 'string' }, checkpoint: { type: 'string' },
    bd: { type: 'string', default: 'bd' }, out: { type: 'string' },
    'debounce-ms': { type: 'string', default: '300' },
    'stop-on-stdin-eof': { type: 'boolean', default: false },
    help: { type: 'boolean' },
  } });
  if (values.help) return null;
  if (!values['beads-dir'] || !values.checkpoint || !values.bd) throw new Error(usage);
  const debounceMs = Number(values['debounce-ms']);
  if (!/^\d+$/.test(values['debounce-ms']) || !Number.isSafeInteger(debounceMs) || debounceMs > 2147483647) {
    throw new Error('--debounce-ms must be an integer from 0 to 2147483647');
  }
  // Resolve CLI paths before changing the child's cwd to the owning workspace.
  const bd = isAbsolute(values.bd) || /[\\/]/.test(values.bd) ? resolve(values.bd) : values.bd;
  const beadsDir = resolve(values['beads-dir']);
  const checkpoint = resolve(values.checkpoint);
  const out = values.out === undefined ? undefined : resolve(values.out);
  if (checkpoint === join(beadsDir, 'issues.jsonl') || checkpoint === out || out === join(beadsDir, 'issues.jsonl')) {
    throw new Error('checkpoint, issues.jsonl and --out must be different files');
  }
  return { beadsDir, checkpoint, bd, out, debounceMs, stopOnStdinEof: values['stop-on-stdin-eof'] };
}

export function supportedVersion(text) {
  const match = text.match(/\b(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?/);
  if (!match) return false;
  const [, major, minor, patch, prerelease] = match;
  return Number(major) > 1 || (Number(major) === 1 &&
    (Number(minor) > 3 || (Number(minor) === 3 && (Number(patch) > 0 || !prerelease))));
}

function sequence(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid journal sequence (expected a nonnegative safe integer)');
  return value;
}

async function renameWithRetry(source, destination, renameFile = rename) {
  // Windows readers/scanners can briefly deny atomic replacement. Never
  // unlink the destination first; the linear wait budget is 900 ms.
  for (let attempt = 0; ; attempt++) {
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 8) throw error;
      await delay(25 * (attempt + 1));
    }
  }
}

async function saveCheckpoint(path, seq, renameCheckpoint) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ seq })}\n`, { flag: 'wx', flush: true });
    await renameWithRetry(temp, path, renameCheckpoint);
  } finally {
    await rm(temp, { force: true });
  }
}

// The spawn/log seams let tests exercise failures and races without a bd install.
// Every production child is spawned directly (no shell or detached process).
export async function follow(options, {
  spawnChild = spawn, log = line => console.error(line), signals = process, stdin = process.stdin,
  renameCheckpoint = rename, renameOutput = rename, removeStaged = rm,
} = {}) {
  const { beadsDir, checkpoint, bd, out, debounceMs } = options;
  const children = new Map();
  let stopping = false;
  let timer;
  let batchStarted;
  const maxWait = Math.min(debounceMs * 10, 2147483647);
  let exportJob;
  let writing = false;
  let abortWrite = false;
  let fatal;
  let graceTimer;
  const stagingDirs = new Set();
  let saved;
  let pending;
  const stopChildren = (includeWrites = false) => {
    for (const [child, state] of children) {
      if (!includeWrites && state.write) continue;
      if (state.terminating) continue;
      state.terminating = true;
      // Each child gets the full intervals from its own SIGTERM, including
      // writers terminated only after the export grace period has elapsed.
      state.killTimer = setTimeout(() => child.kill('SIGKILL'), childKillMs);
      state.closeTimer = setTimeout(() => {
        log(`bmc-follow: child close timeout pid=${child.pid ?? 'unknown'}`);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref?.();
        state.finish(null, 'SIGKILL');
      }, childCloseMs);
      child.kill('SIGTERM');
    }
  };
  const beginShutdown = () => {
    clearTimeout(timer);
    stopChildren();
    if (writing && !graceTimer) graceTimer = setTimeout(() => {
      log('bmc-follow: export grace timeout');
      abortWrite = true;
      stopChildren(true);
    }, exportGraceMs);
  };
  const stop = () => {
    stopping = true;
    beginShutdown();
  };
  const fail = error => {
    fatal ??= error;
    beginShutdown();
  };
  const checkActive = (write = false) => {
    if (abortWrite || (stopping && !write)) throw new Error('stopped');
    if (fatal) throw fatal;
  };

  function command(binary, args, onLine, write = false) {
    checkActive(write);
    const child = spawnChild(binary, args, {
      cwd: dirname(beadsDir), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      // bd's detached send-metrics child inherits cwd and can lock the workspace
      // after bd exits. Keep this helper's process lifetime fully supervised.
      ...(binary === bd ? { env: { ...process.env, BD_DISABLE_EVENT_FLUSH: '1' } } : {}),
    });
    let stdout = '';
    let stderr = '';
    let parseError;
    let pretty = '';
    const lines = onLine && createInterface({ input: child.stdout, crlfDelay: Infinity });
    if (lines) {
      lines.on('line', line => {
        if (!line.trim() || parseError) return;
        try {
          let record;
          // Events are JSONL, but bd 1.3.0's structured error is pretty JSON.
          if (pretty || line.trim() === '{') {
            pretty += `${line}\n`;
            if (Buffer.byteLength(pretty) > 65536) throw new Error('journal JSON exceeds 64 KiB');
            try { record = JSON.parse(pretty); } catch (error) {
              if (line === '}') throw error;
              return;
            }
            pretty = '';
          } else record = JSON.parse(line);
          onLine(record);
        } catch (error) {
          parseError = error;
          child.kill('SIGTERM');
        }
      });
    } else {
      child.stdout.setEncoding('utf8').on('data', data => { stdout = (stdout + data).slice(-65536); });
    }
    child.stderr.setEncoding('utf8').on('data', data => { stderr = (stderr + data).slice(-65536); });
    // Resolve on close, not exit: stdout may still have records buffered at exit.
    let spawnError;
    child.on('error', error => { spawnError = error; });
    let finish;
    const done = new Promise(resolveDone => {
      finish = (code, signal) => {
        const state = children.get(child);
        clearTimeout(state?.killTimer);
        clearTimeout(state?.closeTimer);
        lines?.close();
        children.delete(child);
        resolveDone({ code, signal, stdout, stderr,
          error: spawnError ?? parseError ?? (pretty ? new Error('incomplete journal JSON') : undefined) });
      };
    });
    child.once('close', finish);
    children.set(child, { done, finish, write });
    return done;
  }

  function requireSuccess(result, label, write = false) {
    checkActive(write);
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code ?? result.signal}): ${result.stderr.trim()}`);
    return result.stdout;
  }

  async function cleanupStaged() {
    for (const path of stagingDirs) {
      // Only remove directories returned by mkdtemp in publish(), never glob
      // scratch files belonging to other writers beside the real outputs.
      if (await removeStagingDirectory(path)) stagingDirs.delete(path);
    }
  }

  async function removeStagingDirectory(path) {
    try {
      await removeStaged(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch (error) {
      log(`bmc-follow: staging cleanup failed path=${path}: ${error.message}`);
      return false;
    }
  }

  async function cleanupStaleStaging() {
    const cutoff = Date.now() - staleStagingMs;
    for (const parent of new Set([beadsDir, ...(out ? [dirname(out)] : [])])) {
      try {
        for (const entry of await readdir(parent, { withFileTypes: true })) {
          if (!entry.name.startsWith('.bmc-follow-') || !entry.isDirectory()) continue;
          const path = join(parent, entry.name);
          try {
            const info = await lstat(path);
            if (!info.isDirectory() || info.mtimeMs >= cutoff) continue;
            if (await removeStagingDirectory(path)) log(`bmc-follow: removed stale staging path=${path}`);
          } catch (error) {
            if (error.code !== 'ENOENT') log(`bmc-follow: staging inspection failed path=${path}: ${error.message}`);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') log(`bmc-follow: staging scan failed path=${parent}: ${error.message}`);
      }
    }
  }

  async function publish(path, run) {
    await mkdir(dirname(path), { recursive: true });
    const target = await lstat(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (target?.isSymbolicLink()) throw new Error(`refusing symlink output: ${path}`);
    const directory = await mkdtemp(join(dirname(path), '.bmc-follow-'));
    stagingDirs.add(directory);
    const staged = join(directory, basename(path));
    if (path === out) {
      // refresh reads optional metadata beside --out. Preserve that behavior
      // even though its output and scratch files now live in a private folder.
      await copyFile(join(dirname(out), 'orchestration.meta.json'), join(directory, 'orchestration.meta.json'))
        .catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await run(staged);
    checkActive(true);
    await renameWithRetry(staged, path, renameOutput);
  }

  async function exportAt(seq) {
    checkActive();
    writing = true;
    try {
      await publish(join(beadsDir, 'issues.jsonl'), async staged => {
        requireSuccess(await command(bd, ['export', '-o', staged], undefined, true), 'bd export', true);
      });
      if (out) {
        const binary = process.platform === 'win32' ? 'pwsh' : 'sh';
        const args = process.platform === 'win32'
          ? ['-NoProfile', '-File', join(scriptsDir, 'refresh.ps1'), '-BeadsDir', beadsDir, '-NoBdEnrich', '-Out']
          : [join(scriptsDir, 'refresh.sh'), '--beads-dir', beadsDir, '--no-bd-enrich', '--out'];
        await publish(out, async staged => {
          requireSuccess(await command(binary, [...args, staged], undefined, true), 'snapshot refresh', true);
        });
      }
      checkActive(true);
      await saveCheckpoint(checkpoint, seq, renameCheckpoint);
      saved = seq;
      log(`bmc-follow: exported seq=${seq}`);
    } finally {
      writing = false;
      clearTimeout(graceTimer);
      graceTimer = undefined;
      await cleanupStaged();
    }
  }

  function scheduleExport() {
    clearTimeout(timer);
    if (stopping || fatal || pending <= saved) return;
    batchStarted ??= Date.now();
    if (exportJob) return;
    timer = setTimeout(() => {
      // Freeze the watermark before starting the export. Events arriving while
      // export/refresh runs must trigger another export, never advance this one.
      const seq = pending;
      batchStarted = undefined;
      exportJob = exportAt(seq).catch(fail).finally(() => {
        exportJob = undefined;
        scheduleExport();
      });
    }, Math.min(debounceMs, Math.max(0, maxWait - (Date.now() - batchStarted))));
  }

  async function tail(since, live) {
    let head = 0;
    let truncated;
    const args = ['events', 'tail', '--since', String(since), ...(live ? ['--follow'] : []), '--json'];
    const result = await command(bd, args, record => {
      if (record.code === 'events_journal_truncated') {
        truncated = { floor: sequence(record.floor), head: sequence(record.head) };
        return;
      }
      const seq = sequence(record.seq);
      head = Math.max(head, seq);
      if (live && seq > pending) {
        pending = seq;
        scheduleExport();
      }
    });
    // bd 1.3.0 emits the structured truncation error on stdout. Accept stderr
    // too, without treating an unrelated nonzero exit as a retention gap.
    if (!truncated) {
      for (const line of [result.stderr, ...result.stderr.split(/\r?\n/)]) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.code === 'events_journal_truncated') {
          truncated = { floor: sequence(record.floor), head: sequence(record.head) };
        }
      }
    }
    checkActive();
    if (result.error) throw result.error;
    if (result.code === 1 && truncated) return { ...truncated, truncated: true };
    requireSuccess(result, 'bd events tail');
    if (truncated) throw new Error('unexpected truncation response from bd events tail');
    if (live) throw new Error('bd events tail stopped unexpectedly');
    return { head, truncated: false };
  }

  async function rebuild(reason, head) {
    clearTimeout(timer);
    batchStarted = undefined;
    if (exportJob) await exportJob;
    clearTimeout(timer);
    batchStarted = undefined;
    checkActive();
    log(`bmc-follow: rebuild reason=${reason}`);
    // Read head BEFORE the full export so concurrent writes are replayed.
    await exportAt(head);
    pending = saved;
  }

  signals.on('SIGINT', stop);
  signals.on('SIGTERM', stop);
  const ipc = typeof signals.send === 'function';
  const onMessage = message => { if (message?.type === 'stop') stop(); };
  const onStdinError = error => {
    log(`bmc-follow: stdin error: ${error.message}`);
    stop();
  };
  stdin.on('error', onStdinError);
  if (ipc) {
    signals.on('disconnect', stop);
    signals.on('message', onMessage);
  }
  if (options.stopOnStdinEof && !stdin.isTTY) {
    stdin.on('end', stop);
    stdin.resume();
  }
  try {
    if (options.stopOnStdinEof && stdin.isTTY) throw new Error('--stop-on-stdin-eof requires piped stdin; TTY input is not supported');
    // A parent can close its channel before startup has finished.
    if ((ipc && signals.connected === false) || (options.stopOnStdinEof && stdin.readableEnded)) stop();
    const version = requireSuccess(await command(bd, ['version']), 'bd version');
    if (!supportedVersion(version)) {
      log('bmc-follow: bd >= 1.3.0 is required');
      return 3;
    }
    const journal = requireSuccess(await command(bd, ['config', 'get', 'events-journal']), 'bd config get events-journal');
    if (journal.trim() !== 'true') {
      log('bmc-follow: events-journal must be enabled (bd config set events-journal true)');
      return 4;
    }
    await cleanupStaleStaging();
    let rebuildReason = 'initial';
    let checkpointText;
    try {
      checkpointText = await readFile(checkpoint, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (checkpointText !== undefined) {
      try { saved = sequence(JSON.parse(checkpointText).seq); }
      catch { rebuildReason = 'corrupt-checkpoint'; }
    }
    log(`bmc-follow: start since=${saved ?? 0}`);
    const journalState = await tail(0, false);
    if (saved === undefined) await rebuild(rebuildReason, journalState.head);
    else if (saved > journalState.head) await rebuild('replica-reset', journalState.head);
    pending = saved;
    while (!stopping) {
      const result = await tail(saved, true);
      if (result.truncated) await rebuild('truncated', result.head);
    }
    return 0;
  } catch (error) {
    if (stopping) return 0;
    log(`bmc-follow: ${error.message}`);
    return 1;
  } finally {
    stopping = true;
    clearTimeout(timer);
    beginShutdown();
    try {
      if (exportJob) await exportJob;
      stopChildren(true);
      await Promise.all([...children.values()].map(state => state.done));
      await cleanupStaged();
    } finally {
      for (const state of children.values()) {
        clearTimeout(state.killTimer);
        clearTimeout(state.closeTimer);
      }
      clearTimeout(graceTimer);
      stdin.off('error', onStdinError);
      signals.off('SIGINT', stop);
      signals.off('SIGTERM', stop);
      if (ipc) {
        signals.off('disconnect', stop);
        signals.off('message', onMessage);
        if (signals.connected) signals.disconnect();
      }
      if (options.stopOnStdinEof) {
        stdin.off('end', stop);
        stdin.pause();
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = optionsFromArgs(process.argv.slice(2));
    if (options) process.exitCode = await follow(options);
    else console.log(usage);
  } catch (error) {
    console.error(`bmc-follow: ${error.message}`);
    process.exitCode = 1;
  }
}
