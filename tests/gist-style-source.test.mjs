import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildGistRequestHeaders,
  computeRemoteSnapshotHash,
  disableGistConfig,
  getCssFromRemoteSnapshot,
  parseCliAction,
  readGistConfigFile,
  validateRemoteSnapshot,
  writeGistConfig,
} from '../dist/index.js';

async function createTempConfigPath() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notion-font-customizer-gist-'));
  return path.join(dir, 'gist.json');
}

test('validates notion-stylish remote snapshots with matching content hash', () => {
  const snapshot = {
    version: 1,
    enabled: true,
    css: 'body { color: red; }',
    revision: 7,
    updatedAt: '2026-06-06T02:00:00.000Z',
    updatedBy: 'device-1',
    contentHash: computeRemoteSnapshotHash({
      version: 1,
      enabled: true,
      css: 'body { color: red; }',
    }),
  };

  assert.deepEqual(validateRemoteSnapshot(snapshot), { ok: true, snapshot });
  assert.equal(getCssFromRemoteSnapshot(snapshot), 'body { color: red; }');
});

test('rejects notion-stylish remote snapshots with mismatched content hash', () => {
  const result = validateRemoteSnapshot({
    version: 1,
    enabled: true,
    css: 'body { color: red; }',
    revision: 7,
    updatedAt: '2026-06-06T02:00:00.000Z',
    updatedBy: 'device-1',
    contentHash: 'wrong-hash',
  });

  assert.deepEqual(result, { ok: false, error: 'hash-mismatch' });
});

test('disabled remote snapshots produce empty CSS', () => {
  const snapshot = {
    version: 1,
    enabled: false,
    css: 'body { color: red; }',
    revision: 7,
    updatedAt: '2026-06-06T02:00:00.000Z',
    updatedBy: 'device-1',
    contentHash: computeRemoteSnapshotHash({
      version: 1,
      enabled: false,
      css: 'body { color: red; }',
    }),
  };

  assert.equal(getCssFromRemoteSnapshot(snapshot), '');
});

test('gist config treats githubToken as optional and trims populated values', async () => {
  const configPath = await createTempConfigPath();

  await writeGistConfig(configPath, {
    enabled: true,
    gistId: '  abc123  ',
    githubToken: '  ghp_example  ',
  });

  assert.deepEqual(await readGistConfigFile(configPath), {
    enabled: true,
    gistId: 'abc123',
    githubToken: 'ghp_example',
  });

  const file = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(file, {
    enabled: true,
    gistId: 'abc123',
    githubToken: 'ghp_example',
  });

  const mode = (await stat(configPath)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('gist config defaults missing githubToken to an empty string', async () => {
  const configPath = await createTempConfigPath();

  await writeGistConfig(configPath, {
    enabled: true,
    gistId: 'abc123',
  });

  assert.deepEqual(await readGistConfigFile(configPath), {
    enabled: true,
    gistId: 'abc123',
    githubToken: '',
  });
});

test('disableGistConfig preserves existing gist id and token', async () => {
  const configPath = await createTempConfigPath();
  await writeGistConfig(configPath, {
    enabled: true,
    gistId: 'abc123',
    githubToken: 'ghp_example',
  });

  await disableGistConfig(configPath);

  assert.deepEqual(await readGistConfigFile(configPath), {
    enabled: false,
    gistId: 'abc123',
    githubToken: 'ghp_example',
  });
});

test('buildGistRequestHeaders omits Authorization when token is empty', () => {
  assert.deepEqual(buildGistRequestHeaders(''), {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'notion-font-customizer',
    'X-GitHub-Api-Version': '2022-11-28',
  });
});

test('buildGistRequestHeaders includes Authorization when token is present', () => {
  assert.deepEqual(buildGistRequestHeaders('  ghp_example  '), {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ghp_example',
    'User-Agent': 'notion-font-customizer',
    'X-GitHub-Api-Version': '2022-11-28',
  });
});

test('parseCliAction supports gist configuration without requiring a token', () => {
  assert.deepEqual(parseCliAction(['--configure-gist', '--gist-id', 'abc123']), {
    kind: 'configure-gist',
    gistId: 'abc123',
    githubToken: '',
  });
});

test('parseCliAction preserves existing patch and restore options', () => {
  assert.deepEqual(parseCliAction([]), { kind: 'patch', force: false });
  assert.deepEqual(parseCliAction(['--force']), { kind: 'patch', force: true });
  assert.deepEqual(parseCliAction(['--restore']), { kind: 'restore' });
  assert.deepEqual(parseCliAction(['--disable-gist']), { kind: 'disable-gist' });
});
