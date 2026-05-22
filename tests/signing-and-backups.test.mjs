import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodesignArgs,
  buildPkcs12ExportArgs,
  buildSecurityImportArgs,
  getBackupPathsForVersion,
  getPatchAction,
  parseCodeSigningIdentities,
} from '../dist/index.js';

test('parseCodeSigningIdentities returns the matching identity hash and name', () => {
  const output = [
    '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Someone"',
    '  2) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Notion Font Customizer Local Code Signing"',
    '     2 valid identities found',
  ].join('\n');

  assert.deepEqual(
    parseCodeSigningIdentities(output, 'Notion Font Customizer Local Code Signing'),
    {
      hash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
      name: 'Notion Font Customizer Local Code Signing',
    },
  );
});

test('parseCodeSigningIdentities returns null when the target identity is absent', () => {
  assert.equal(parseCodeSigningIdentities('     0 valid identities found', 'Missing Identity'), null);
});

test('buildCodesignArgs uses stable identity without preserving runtime flags or old requirements', () => {
  const args = buildCodesignArgs('ABCDEF0123456789ABCDEF0123456789ABCDEF01', '/Applications/Notion.app');

  assert.deepEqual(args, [
    '--force',
    '--deep',
    '--sign',
    'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    '--timestamp=none',
    '--preserve-metadata=identifier,entitlements',
    '/Applications/Notion.app',
  ]);
  assert.equal(args.some((arg) => arg.includes('requirements')), false);
  assert.equal(args.some((arg) => arg.includes('runtime')), false);
  assert.equal(args.some((arg) => arg.includes('flags')), false);
});

test('buildPkcs12ExportArgs uses a non-empty passphrase and macOS-compatible encryption', () => {
  const args = buildPkcs12ExportArgs(
    '/tmp/identity.p12',
    '/tmp/identity.key',
    '/tmp/identity.crt',
    'Notion Font Customizer Local Code Signing',
    'temporary-passphrase',
  );

  assert.deepEqual(args, [
    'pkcs12',
    '-export',
    '-out',
    '/tmp/identity.p12',
    '-inkey',
    '/tmp/identity.key',
    '-in',
    '/tmp/identity.crt',
    '-name',
    'Notion Font Customizer Local Code Signing',
    '-keypbe',
    'PBE-SHA1-3DES',
    '-certpbe',
    'PBE-SHA1-3DES',
    '-macalg',
    'sha1',
    '-passout',
    'pass:temporary-passphrase',
  ]);
});

test('buildSecurityImportArgs uses the same non-empty p12 passphrase', () => {
  assert.deepEqual(buildSecurityImportArgs('/tmp/identity.p12', '/tmp/login.keychain-db', 'temporary-passphrase'), [
    'import',
    '/tmp/identity.p12',
    '-k',
    '/tmp/login.keychain-db',
    '-f',
    'pkcs12',
    '-P',
    'temporary-passphrase',
    '-T',
    '/usr/bin/codesign',
  ]);
});

test('getPatchAction re-signs an already patched app instead of skipping', () => {
  assert.equal(getPatchAction({ force: false, backupExists: true, currentAsarPatched: true }), 'resign');
});

test('getPatchAction patches when forced or when current app is not patched', () => {
  assert.equal(getPatchAction({ force: true, backupExists: true, currentAsarPatched: true }), 'patch');
  assert.equal(getPatchAction({ force: false, backupExists: true, currentAsarPatched: false }), 'patch');
});

test('getBackupPathsForVersion keeps Notion backups outside the app bundle', () => {
  assert.deepEqual(getBackupPathsForVersion('/Users/example/Library/Application Support/notion-font-customizer', '7.16.0'), {
    dir: '/Users/example/Library/Application Support/notion-font-customizer/backups/7.16.0',
    appAsar: '/Users/example/Library/Application Support/notion-font-customizer/backups/7.16.0/app.asar',
    infoPlist: '/Users/example/Library/Application Support/notion-font-customizer/backups/7.16.0/Info.plist',
  });
});
