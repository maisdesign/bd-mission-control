#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const usage = 'Usage: node scripts/follow.mjs --beads-dir <path/to/.beads> --checkpoint <file> [--bd <binary>] [--out <file>] [--debounce-ms <n>] [--stop-on-stdin-eof]';

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

async function saveCheckpoint(path, seq) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ seq })}\n`, { flag: 'wx', flush: true });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

// The spawn/log seams let tests exercise failures and races without a bd install.
// Every production child is spawned directly (no shell or detached process).
export async function follow(options, {
  spawnChild = spawn, log = line => console.error(line), signals = process, stdin = process.stdin,
} = {}) {
  const { beadsDir, checkpoint, bd, out, debounceMs } = options;
  const children = new Map();
  let stopping = false;
  let timer;
  let exportJob;
  let fatal;
  let killTimer;
  let saved;
  let pending;
  const stopChildren = () => {
    for (const child of children.keys()) child.kill('SIGTERM');
    killTimer ??= setTimeout(() => {
      for (const child of children.keys()) child.kill('SIGKILL');
    }, 1000);
  };
  const stop = () => {
    stopping = true;
    clearTimeout(timer);
    stopChildren();
  };
  const fail = error => {
    fatal ??= error;
    clearTimeout(timer);
    stopChildren();
  };
  const checkActive = () => {
    if (stopping) throw new Error('stopped');
    if (fatal) throw fatal;
  };

  function command(binary, args, onLine) {
    checkActive();
    const child = spawnChild(binary, args, {
      cwd: dirname(beadsDir), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
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
            try { record = JSON.parse(pretty); } catch (error) {
              if (pretty.length > 65536 || line.trim() === '}') throw error;
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
    const done = new Promise(resolveDone => child.once('close', (code, signal) => {
      lines?.close();
      children.delete(child);
      resolveDone({ code, signal, stdout, stderr,
        error: spawnError ?? parseError ?? (pretty ? new Error('incomplete journal JSON') : undefined) });
    }));
    children.set(child, done);
    return done;
  }

  function requireSuccess(result, label) {
    checkActive();
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code ?? result.signal}): ${result.stderr.trim()}`);
    return result.stdout;
  }

  async function exportAt(seq) {
    requireSuccess(await command(bd, ['export', '-o', join(beadsDir, 'issues.jsonl')]), 'bd export');
    if (out) {
      const binary = process.platform === 'win32' ? 'pwsh' : 'sh';
      const args = process.platform === 'win32'
        ? ['-NoProfile', '-File', join(scriptsDir, 'refresh.ps1'), '-BeadsDir', beadsDir, '-NoBdEnrich', '-Out', out]
        : [join(scriptsDir, 'refresh.sh'), '--beads-dir', beadsDir, '--no-bd-enrich', '--out', out];
      requireSuccess(await command(binary, args), 'snapshot refresh');
    }
    checkActive();
    await saveCheckpoint(checkpoint, seq);
    saved = seq;
    log(`bmc-follow: exported seq=${seq}`);
  }

  function scheduleExport() {
    clearTimeout(timer);
    if (stopping || fatal || exportJob || pending <= saved) return;
    timer = setTimeout(() => {
      // Freeze the watermark before starting the export. Events arriving while
      // export/refresh runs must trigger another export, never advance this one.
      const seq = pending;
      exportJob = exportAt(seq).catch(fail).finally(() => {
        exportJob = undefined;
        scheduleExport();
      });
    }, debounceMs);
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
    if (exportJob) await exportJob;
    clearTimeout(timer);
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
  if (ipc) {
    signals.on('disconnect', stop);
    signals.on('message', onMessage);
  }
  if (options.stopOnStdinEof) {
    stdin.on('end', stop);
    stdin.resume();
  }
  try {
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
    try {
      saved = sequence(JSON.parse(await readFile(checkpoint, 'utf8')).seq);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    log(`bmc-follow: start since=${saved ?? 0}`);
    const journalState = await tail(0, false);
    if (saved === undefined) await rebuild('initial', journalState.head);
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
    stopChildren();
    // Escalate only if a child ignores SIGTERM; wait for it before exiting.
    try {
      await Promise.all([...children.values()]);
      if (exportJob) await exportJob;
    } finally {
      clearTimeout(killTimer);
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
