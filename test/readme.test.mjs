import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = resolve(repoRoot, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
const allowedMissing = new Set(['docs/screenshot.png']);

function normalizeRelativeTarget(target) {
  const withoutFragment = target.split('#')[0];
  const withoutQuery = withoutFragment.split('?')[0];
  return withoutQuery.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function extractRelativeTargets(markdown) {
  const matches = markdown.matchAll(/!?\[[^\]]*?\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g);
  const targets = [];

  for (const match of matches) {
    const rawTarget = match[1].trim();
    if (!rawTarget || /^(?:https?:|mailto:)/i.test(rawTarget) || rawTarget.startsWith('#')) {
      continue;
    }
    targets.push(normalizeRelativeTarget(rawTarget));
  }

  return targets;
}

test('README keeps required top-level sections', () => {
  for (const heading of ['## Quickstart', '## Config', '## FAQ', '## License']) {
    assert.match(readme, new RegExp(`^${heading}$`, 'm'));
  }
});

test('README relative links and images resolve inside the repo', () => {
  const targets = extractRelativeTargets(readme);
  assert.ok(targets.length > 0, 'expected at least one relative README path');

  for (const target of targets) {
    if (allowedMissing.has(target)) {
      continue;
    }
    assert.equal(
      existsSync(resolve(repoRoot, target)),
      true,
      `README target does not exist: ${target}`
    );
  }
});
