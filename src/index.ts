/**
 * Notion Custom Font Patcher
 *
 * Features:
 *   - Extracts Notion app.asar and injects custom CSS hot-reload code into preload.js
 *   - Supports --restore to revert to the original app.asar
 *
 * Usage:
 *   notion-font-customizer          # Apply patch
 *   notion-font-customizer --restore  # Restore original state
 */

import * as asar from '@electron/asar';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Paths
const NOTION_APP = '/Applications/Notion.app';
const NOTION_RESOURCES = path.join(NOTION_APP, 'Contents/Resources');
const APP_ASAR = path.join(NOTION_RESOURCES, 'app.asar');
const LEGACY_APP_ASAR_BAK = path.join(NOTION_RESOURCES, 'app.asar.bak');
const APP_ASAR_UNPACKED = path.join(NOTION_RESOURCES, 'app.asar.unpacked');
const APP_DIR = path.join(NOTION_RESOURCES, 'app');
const PRELOAD_JS = path.join(APP_DIR, '.webpack/renderer/tab_browser_view/preload.js');
const MAIN_INDEX_JS = path.join(APP_DIR, '.webpack/main/index.js');

const INFO_PLIST = path.join(NOTION_APP, 'Contents/Info.plist');
const LEGACY_INFO_PLIST_BAK = path.join(NOTION_APP, 'Contents/Info.plist.bak');

const CONFIG_DIR = path.join(os.homedir(), '.config/notion');
const CUSTOM_CSS = path.join(CONFIG_DIR, 'custom.css');
const GIST_CONFIG = path.join(CONFIG_DIR, 'gist.json');
const SUPPORT_DIR = path.join(os.homedir(), 'Library/Application Support/notion-font-customizer');

const SIGNING_IDENTITY_NAME = 'Notion Font Customizer Local Code Signing';
const GIST_API_VERSION = '2022-11-28';
const GIST_SYNC_FILE_NAME = 'notion-stylish.json';
const SNAPSHOT_VERSION = 1;

const INJECT_MARKER = '// [notion-custom-font] injected';
const INJECT_MAIN_MARKER = '// [notion-custom-font] main process injected';

export type GistConfig = {
  enabled: boolean;
  gistId: string;
  githubToken: string;
};

export type RemoteSnapshot = {
  version: 1;
  enabled: boolean;
  css: string;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  contentHash: string;
};

export type CliAction =
  | { kind: 'help' }
  | { kind: 'restore' }
  | { kind: 'configure-gist'; gistId: string; githubToken: string }
  | { kind: 'disable-gist' }
  | { kind: 'patch'; force: boolean };

type RemoteSnapshotHashInput = Pick<RemoteSnapshot, 'version' | 'enabled' | 'css'>;

export function canonicalRemoteSnapshotContent(input: RemoteSnapshotHashInput): string {
  return JSON.stringify({
    version: input.version,
    enabled: input.enabled,
    css: input.css,
  });
}

export function computeRemoteSnapshotHash(input: RemoteSnapshotHashInput): string {
  return crypto.createHash('sha256').update(canonicalRemoteSnapshotContent(input)).digest('hex');
}

export function validateRemoteSnapshot(value: unknown):
  | { ok: true; snapshot: RemoteSnapshot }
  | { ok: false; error: 'invalid-json' | 'hash-mismatch' } {
  if (!isRecord(value)) {
    return { ok: false, error: 'invalid-json' };
  }

  if (
    value.version !== SNAPSHOT_VERSION ||
    typeof value.enabled !== 'boolean' ||
    typeof value.css !== 'string' ||
    typeof value.revision !== 'number' ||
    typeof value.updatedAt !== 'string' ||
    typeof value.updatedBy !== 'string' ||
    typeof value.contentHash !== 'string'
  ) {
    return { ok: false, error: 'invalid-json' };
  }

  const expectedHash = computeRemoteSnapshotHash({
    version: SNAPSHOT_VERSION,
    enabled: value.enabled,
    css: value.css,
  });
  if (expectedHash !== value.contentHash) {
    return { ok: false, error: 'hash-mismatch' };
  }

  return { ok: true, snapshot: value as RemoteSnapshot };
}

export function getCssFromRemoteSnapshot(snapshot: Pick<RemoteSnapshot, 'enabled' | 'css'>): string {
  return snapshot.enabled ? snapshot.css : '';
}

export function normalizeGistConfig(value: unknown): GistConfig | null {
  if (!isRecord(value)) return null;
  if (typeof value.enabled !== 'boolean' || typeof value.gistId !== 'string') return null;
  const githubToken = typeof value.githubToken === 'string' ? value.githubToken.trim() : '';
  const gistId = value.gistId.trim();
  if (value.enabled && !gistId) return null;
  return {
    enabled: value.enabled,
    gistId,
    githubToken,
  };
}

export function readGistConfigFile(configPath = GIST_CONFIG): GistConfig | null {
  try {
    return normalizeGistConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch {
    return null;
  }
}

export function writeGistConfig(
  configPath: string,
  input: { enabled?: boolean; gistId: string; githubToken?: string },
): GistConfig {
  const config: GistConfig = {
    enabled: input.enabled ?? true,
    gistId: input.gistId.trim(),
    githubToken: input.githubToken?.trim() ?? '',
  };
  if (config.enabled && !config.gistId) {
    throw new Error('Gist ID is required when Gist style source is enabled.');
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.chmodSync(configPath, 0o600);
  return config;
}

export function disableGistConfig(configPath = GIST_CONFIG): GistConfig {
  const existing = readGistConfigFile(configPath) ?? {
    enabled: false,
    gistId: '',
    githubToken: '',
  };
  return writeGistConfig(configPath, {
    enabled: false,
    gistId: existing.gistId,
    githubToken: existing.githubToken,
  });
}

export function buildGistRequestHeaders(githubToken = ''): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'notion-font-customizer',
    'X-GitHub-Api-Version': GIST_API_VERSION,
  };
  const token = githubToken.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function parseCliAction(args: string[]): CliAction {
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help' };
  if (args.includes('--restore')) return { kind: 'restore' };
  if (args.includes('--disable-gist')) return { kind: 'disable-gist' };
  if (args.includes('--configure-gist')) {
    return {
      kind: 'configure-gist',
      gistId: readCliOption(args, '--gist-id'),
      githubToken: readCliOption(args, '--github-token', ''),
    };
  }
  return { kind: 'patch', force: args.includes('--force') };
}

function readCliOption(args: string[], name: string, fallback?: string): string {
  const index = args.indexOf(name);
  if (index === -1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is required.`);
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} requires a value.`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const INJECT_JS = String.raw`${INJECT_MARKER}
;(function() {
  const { ipcRenderer } = require('electron');
  const STYLE_ID = 'notion-custom-font';

  function applyCSS(css) {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = css;
  }

  async function loadInitialCSS() {
    try {
      const css = await ipcRenderer.invoke('notion-custom:get-css');
      applyCSS(css);
    } catch (e) { console.error('[notion-custom-font]', e); }
  }

  ipcRenderer.on('notion-custom:css-changed', (_event, css) => {
    applyCSS(css);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadInitialCSS);
  } else {
    loadInitialCSS();
  }
})();`;

const INJECT_MAIN_JS = String.raw`${INJECT_MAIN_MARKER}
;(function() {
  const { ipcMain, webContents } = require('electron');
  const crypto = require('crypto');
  const fs = require('fs');
  const https = require('https');
  const path = require('path');
  const configDir = path.join(process.env.HOME || '', '.config', 'notion');
  const cssPath = path.join(configDir, 'custom.css');
  const gistConfigPath = path.join(configDir, 'gist.json');
  const gistCachePath = path.join(configDir, 'gist-cache.json');
  const fontsDir = path.join(configDir, 'fonts');
  const gistSyncFileName = 'notion-stylish.json';
  const snapshotVersion = 1;
  let gistCssPromise = null;
  try { fs.mkdirSync(fontsDir, { recursive: true }); } catch(e) {}

  function readCSS() {
    try {
      return fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
    } catch (e) { return ''; }
  }

  function readJSONFile(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  function readGistConfig() {
    const value = readJSONFile(gistConfigPath);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.enabled !== 'boolean' || typeof value.gistId !== 'string') return null;
    const gistId = value.gistId.trim();
    const githubToken = typeof value.githubToken === 'string' ? value.githubToken.trim() : '';
    if (value.enabled && !gistId) return null;
    return { enabled: value.enabled, gistId, githubToken };
  }

  function isGistEnabled() {
    const config = readGistConfig();
    return !!(config && config.enabled);
  }

  function canonicalRemoteSnapshotContent(input) {
    return JSON.stringify({
      version: input.version,
      enabled: input.enabled,
      css: input.css,
    });
  }

  function computeRemoteSnapshotHash(input) {
    return crypto.createHash('sha256').update(canonicalRemoteSnapshotContent(input)).digest('hex');
  }

  function validateRemoteSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'invalid-json' };
    }
    if (
      value.version !== snapshotVersion ||
      typeof value.enabled !== 'boolean' ||
      typeof value.css !== 'string' ||
      typeof value.revision !== 'number' ||
      typeof value.updatedAt !== 'string' ||
      typeof value.updatedBy !== 'string' ||
      typeof value.contentHash !== 'string'
    ) {
      return { ok: false, error: 'invalid-json' };
    }
    const expectedHash = computeRemoteSnapshotHash({
      version: snapshotVersion,
      enabled: value.enabled,
      css: value.css,
    });
    if (expectedHash !== value.contentHash) {
      return { ok: false, error: 'hash-mismatch' };
    }
    return { ok: true, snapshot: value };
  }

  function getCssFromRemoteSnapshot(snapshot) {
    return snapshot.enabled ? snapshot.css : '';
  }

  function readCachedSnapshot() {
    const validation = validateRemoteSnapshot(readJSONFile(gistCachePath));
    return validation.ok ? validation.snapshot : null;
  }

  function writeCachedSnapshot(snapshot) {
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(gistCachePath, JSON.stringify(snapshot, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.chmodSync(gistCachePath, 0o600);
    } catch (e) {}
  }

  function buildGistRequestHeaders(githubToken) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'notion-font-customizer',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const token = (githubToken || '').trim();
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  function fetchURL(url) {
    return new Promise((resolve, reject) => {
      https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchURL(res.headers.location).then(resolve, reject);
          return;
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }

  function fetchJSON(url, headers) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchJSON(res.headers.location, headers).then(resolve, reject);
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error('GitHub API failed with HTTP ' + res.statusCode));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('GitHub API response is not valid JSON'));
          }
        });
      });
      req.setTimeout(15000, () => req.destroy(new Error('GitHub API request timed out')));
      req.on('error', reject);
    });
  }

  async function fetchGistSnapshot(config) {
    const body = await fetchJSON(
      'https://api.github.com/gists/' + encodeURIComponent(config.gistId),
      buildGistRequestHeaders(config.githubToken)
    );
    const file = body && body.files && body.files[gistSyncFileName];
    if (!file || typeof file.content !== 'string') {
      throw new Error('Gist does not contain ' + gistSyncFileName);
    }
    if (file.truncated) {
      throw new Error(gistSyncFileName + ' is truncated by GitHub API');
    }
    let parsed;
    try {
      parsed = JSON.parse(file.content);
    } catch (e) {
      throw new Error(gistSyncFileName + ' is not valid JSON');
    }
    const validation = validateRemoteSnapshot(parsed);
    if (!validation.ok) {
      throw new Error('Invalid ' + gistSyncFileName + ': ' + validation.error);
    }
    return validation.snapshot;
  }

  function formatError(error) {
    if (!error) return 'Unknown error';
    if (error instanceof Error) return error.message || error.name || 'Unknown error';
    return String(error);
  }

  async function readGistCSS(config) {
    try {
      const snapshot = await fetchGistSnapshot(config);
      writeCachedSnapshot(snapshot);
      return resolveImports(getCssFromRemoteSnapshot(snapshot));
    } catch (e) {
      console.error('[notion-custom-font] Failed to fetch Gist style:', formatError(e));
      const cached = readCachedSnapshot();
      return cached ? resolveImports(getCssFromRemoteSnapshot(cached)) : null;
    }
  }

  async function readActiveCSS() {
    const config = readGistConfig();
    if (config && config.enabled) {
      if (!gistCssPromise) gistCssPromise = readGistCSS(config);
      const gistCSS = await gistCssPromise;
      if (gistCSS !== null) return gistCSS;
    }
    return resolveImports(readCSS());
  }

  function fetchBinary(url) {
    return new Promise((resolve, reject) => {
      https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchBinary(res.headers.location).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
  }

  async function resolveFontURLs(css) {
    const fontUrlRe = /url\(\s*['"]?(https:\/\/fonts\.gstatic\.com\/[^'")\s]+)['"]?\s*\)/g;
    let match;
    const fonts = [];
    while ((match = fontUrlRe.exec(css)) !== null) {
      fonts.push({ full: match[0], url: match[1] });
    }
    if (fonts.length === 0) return css;
    let resolved = css;
    for (const font of fonts) {
      try {
        const hash = crypto.createHash('sha256').update(font.url).digest('hex');
        const ext = font.url.match(/\.(woff2|woff|ttf|otf|eot)/i);
        const suffix = ext ? '.' + ext[1].toLowerCase() : '.woff2';
        const cached = path.join(fontsDir, hash + suffix);
        let buf;
        if (fs.existsSync(cached)) {
          buf = fs.readFileSync(cached);
        } else {
          buf = await fetchBinary(font.url);
          fs.writeFileSync(cached, buf);
        }
        const mime = 'font/' + suffix.slice(1);
        const dataUri = 'data:' + mime + ';base64,' + buf.toString('base64');
        resolved = resolved.replace(font.full, 'url(' + dataUri + ')');
      } catch (e) {
        console.error('[notion-custom-font] Failed to fetch font:', font.url, e.message || e);
      }
    }
    return resolved;
  }

  async function resolveImports(css) {
    // Branch matching: quoted (single/double) vs unquoted — handles URLs with embedded special chars
    const importRe = /@import\s+url\(\s*(?:'([^']*)'|"([^"]*)"|([^)\s]+))\s*\)\s*;?/g;
    let match;
    const imports = [];
    while ((match = importRe.exec(css)) !== null) {
      imports.push({ full: match[0], url: match[1] || match[2] || match[3] });
    }
    if (imports.length === 0) return css;
    let resolved = css;
    for (const imp of imports) {
      try {
        const fetched = await fetchURL(imp.url);
        resolved = resolved.replace(imp.full, fetched);
      } catch (e) {
        console.error('[notion-custom-font] Failed to fetch:', imp.url, e.message || e);
      }
    }
    // Safety net: strip any remaining @import rules to prevent CSP violations
    resolved = resolved.replace(/@import\s+url\([^)]*\)\s*;?/g, '/* [notion-custom-font] removed unresolved @import */');
    return resolveFontURLs(resolved);
  }

  ipcMain.handle('notion-custom:get-css', async () => readActiveCSS());

  // Hot reload local custom.css only when the Gist source is disabled.
  try {
    if (!isGistEnabled()) {
      let debounceTimer;
      fs.watch(cssPath, () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const css = await resolveImports(readCSS());
          webContents.getAllWebContents().forEach(wc => {
            if (!wc.isDestroyed()) wc.send('notion-custom:css-changed', css);
          });
        }, 200);
      });
    }
  } catch (e) {}

})();`;

const DEFAULT_CSS = `/* Notion 自定义字体配置 */
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@100..900&family=Pridi:wght@200;300;400;500;600;700&family=Signika:wght@300..700&display=swap');

/* === 中文字体映射 === */
@font-face {
  font-family: 'XinFang';
  src: local('TsangerHuaXinTi');
  font-weight: 400;
}

@font-face {
  font-family: 'XinFang';
  src: local('TsangerYunHei-W06');
  font-weight: 600;
}

@font-face {
  font-family: 'XinFang';
  src: local('TsangerYunHei-W06');
  font-weight: 700;
}

@font-face {
  font-family: 'YunHei';
  src: local('TsangerYunHei-W06');
  font-weight: 600;
}

@font-face {
  font-family: 'YunHei';
  src: local('TsangerYunHei-W06');
  font-weight: 700;
}

/* === 正文内容字体 === */
div.notion-page-content *,
div.notion-collection-item *,
div.layout-chat *,
div.chat_sidebar * {
  font-family: "Caecilia LT Std", "Pridi", XinFang, "Noto Sans SC", STKaiti, -apple-system,
    BlinkMacSystemFont, "Segoe UI", Helvetica, "Apple Color Emoji",
    Arial, sans-serif, "Segoe UI Emoji", "Segoe UI Symbol" !important;
  line-height: 1.8em !important;
}

/* === 标题字体 === */
/* notion-page-block 同时出现在正文和此处，
   此规则在后面声明，优先级更高，确保标题使用 Space Grotesk */
div.notion-header-block span,
div.notion-header-block div,
div.notion-sub_header-block span,
div.notion-sub_header-block div,
div.notion-sub_sub_header-block span,
div.notion-sub_sub_header-block div,
div.notion-page-block span,
div.notion-page-block div,
div.notion-page-block h1,
div.notion-page-block h2,
div.notion-page-block h3 {
  font-family: "Signika", "Oswald", "Space Grotesk", YunHei, "Noto Sans SC", "PingFang SC" !important;
}

/* === 代码块字体（启用连字） === */
div.notion-code-block div span {
  font-family: "FiraCode Nerd Font", "JetBrains Mono", Consolas, monospace !important;
  font-feature-settings: "liga" 1, "calt" 1;
}
`;

function getNotionVersion(plistPath: string): string {
  return execFileSync(
    'plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plistPath],
    { encoding: 'utf8' },
  ).trim();
}

type BackupPaths = {
  dir: string;
  appAsar: string;
  infoPlist: string;
};

type CodeSigningIdentity = {
  hash: string;
  name: string;
};

type PatchAction = 'patch' | 'resign';

export function getBackupPathsForVersion(supportDir: string, notionVersion: string): BackupPaths {
  const dir = path.join(supportDir, 'backups', notionVersion);
  return {
    dir,
    appAsar: path.join(dir, 'app.asar'),
    infoPlist: path.join(dir, 'Info.plist'),
  };
}

export function parseCodeSigningIdentities(
  output: string,
  targetName: string,
): CodeSigningIdentity | null {
  const identityRe = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"$/gm;
  let match: RegExpExecArray | null;
  while ((match = identityRe.exec(output)) !== null) {
    if (match[2] === targetName) {
      return { hash: match[1].toUpperCase(), name: match[2] };
    }
  }
  return null;
}

export function buildCodesignArgs(identity: string, appPath: string): string[] {
  return [
    '--force',
    '--deep',
    '--sign',
    identity,
    '--timestamp=none',
    '--preserve-metadata=identifier',
    appPath,
  ];
}

export function buildPkcs12ExportArgs(
  p12File: string,
  keyFile: string,
  certFile: string,
  identityName: string,
  passphrase: string,
): string[] {
  return [
    'pkcs12',
    '-export',
    '-out',
    p12File,
    '-inkey',
    keyFile,
    '-in',
    certFile,
    '-name',
    identityName,
    '-keypbe',
    'PBE-SHA1-3DES',
    '-certpbe',
    'PBE-SHA1-3DES',
    '-macalg',
    'sha1',
    '-passout',
    `pass:${passphrase}`,
  ];
}

export function buildSecurityImportArgs(
  p12File: string,
  loginKeychain: string,
  passphrase: string,
): string[] {
  return [
    'import',
    p12File,
    '-k',
    loginKeychain,
    '-f',
    'pkcs12',
    '-P',
    passphrase,
    '-T',
    '/usr/bin/codesign',
  ];
}

export function getPatchAction(options: {
  force: boolean;
  backupExists: boolean;
  currentAsarPatched: boolean;
}): PatchAction {
  if (!options.force && options.backupExists && options.currentAsarPatched) {
    return 'resign';
  }
  return 'patch';
}

function getBackupPaths(version = getNotionVersion(INFO_PLIST)): BackupPaths {
  return getBackupPathsForVersion(SUPPORT_DIR, version);
}

function migrateLegacyBackups(): void {
  const hasLegacyAppAsar = fs.existsSync(LEGACY_APP_ASAR_BAK);
  const hasLegacyInfoPlist = fs.existsSync(LEGACY_INFO_PLIST_BAK);
  if (!hasLegacyAppAsar && !hasLegacyInfoPlist) return;

  const backupVersion = hasLegacyInfoPlist
    ? getNotionVersion(LEGACY_INFO_PLIST_BAK)
    : getNotionVersion(INFO_PLIST);
  const backup = getBackupPaths(backupVersion);
  fs.mkdirSync(backup.dir, { recursive: true });

  if (hasLegacyAppAsar) {
    if (!fs.existsSync(backup.appAsar)) {
      console.log(`Migrating legacy app.asar backup → ${backup.appAsar}`);
      fs.copyFileSync(LEGACY_APP_ASAR_BAK, backup.appAsar);
    }
    fs.unlinkSync(LEGACY_APP_ASAR_BAK);
  }

  if (hasLegacyInfoPlist) {
    if (!fs.existsSync(backup.infoPlist)) {
      console.log(`Migrating legacy Info.plist backup → ${backup.infoPlist}`);
      fs.copyFileSync(LEGACY_INFO_PLIST_BAK, backup.infoPlist);
    }
    fs.unlinkSync(LEGACY_INFO_PLIST_BAK);
  }
}

function backupAsar(): BackupPaths {
  migrateLegacyBackups();
  const currentVer = getNotionVersion(INFO_PLIST);
  const backup = getBackupPaths(currentVer);

  if (fs.existsSync(backup.appAsar) && fs.existsSync(backup.infoPlist)) {
    console.log(`Backup already exists (version ${currentVer}). Skipping.`);
    return backup;
  }

  fs.mkdirSync(backup.dir, { recursive: true });

  if (!fs.existsSync(backup.appAsar)) {
    if (!fs.existsSync(APP_ASAR)) {
      console.error(`Error: ${APP_ASAR} not found.`);
      process.exit(1);
    }
    console.log(`Backing up app.asar → ${backup.appAsar}`);
    fs.copyFileSync(APP_ASAR, backup.appAsar);
  }

  if (!fs.existsSync(backup.infoPlist)) {
    if (!fs.existsSync(INFO_PLIST)) {
      console.error(`Error: ${INFO_PLIST} not found.`);
      process.exit(1);
    }
    console.log(`Backing up Info.plist → ${backup.infoPlist}`);
    fs.copyFileSync(INFO_PLIST, backup.infoPlist);
  }

  return backup;
}

function extractAsar(backup: BackupPaths): void {
  if (fs.existsSync(APP_DIR)) {
    console.log(`Removing old app/ directory: ${APP_DIR}`);
    fs.rmSync(APP_DIR, { recursive: true, force: true });
  }

  if (!fs.existsSync(backup.appAsar)) {
    console.error(`Error: backup file not found: ${backup.appAsar}`);
    process.exit(1);
  }

  // asar looks for <archive>.unpacked/ for native .node files.
  // Since backups live outside the app bundle, temporarily point the backup
  // archive's unpacked directory at Notion's real app.asar.unpacked directory.
  const bakUnpacked = `${backup.appAsar}.unpacked`;
  const symlinkCreated =
    fs.existsSync(APP_ASAR_UNPACKED) && !fs.existsSync(bakUnpacked);
  if (symlinkCreated) {
    fs.symlinkSync(APP_ASAR_UNPACKED, bakUnpacked);
  }

  try {
    console.log(`Extracting ${backup.appAsar} → ${APP_DIR}`);
    asar.extractAll(backup.appAsar, APP_DIR);
  } finally {
    if (symlinkCreated && fs.existsSync(bakUnpacked)) {
      fs.unlinkSync(bakUnpacked);
    }
  }
}

function injectPreload(): void {
  if (!fs.existsSync(PRELOAD_JS)) {
    console.error(`Error: preload.js not found: ${PRELOAD_JS}`);
    process.exit(1);
  }

  const content = fs.readFileSync(PRELOAD_JS, 'utf8');
  if (content.includes(INJECT_MARKER)) {
    console.log('preload.js already contains injected code. Skipping.');
    return;
  }

  console.log(`Injecting CSS hot-reload code → ${PRELOAD_JS}`);
  fs.writeFileSync(PRELOAD_JS, content + '\n' + INJECT_JS, 'utf8');
}

function injectMainProcess(): void {
  if (!fs.existsSync(MAIN_INDEX_JS)) {
    console.error(`Error: main/index.js not found: ${MAIN_INDEX_JS}`);
    process.exit(1);
  }

  const content = fs.readFileSync(MAIN_INDEX_JS, 'utf8');
  if (content.includes(INJECT_MAIN_MARKER)) {
    console.log('main/index.js already contains injected code. Skipping.');
    return;
  }

  console.log(`Injecting IPC handler code → ${MAIN_INDEX_JS}`);
  fs.writeFileSync(MAIN_INDEX_JS, content + '\n' + INJECT_MAIN_JS, 'utf8');
}

async function repackAsar(): Promise<void> {
  console.log(`Repacking ${APP_DIR} → ${APP_ASAR}`);
  await asar.createPackageWithOptions(APP_DIR, APP_ASAR, { unpack: '**/*.node' });
  console.log(`Cleaning up temp directory: ${APP_DIR}`);
  fs.rmSync(APP_DIR, { recursive: true, force: true });
}

function updateAsarHash(): void {
  /**
   * asar file format:
   *   Byte 0-3:   pickle payload size (uint32 LE)
   *   Byte 4-7:   header buffer length (uint32 LE)
   *   Byte 8-11:  header pickle payload size (uint32 LE)
   *   Byte 12-15: header string length (uint32 LE) → N
   *   Byte 16 ~ 16+N: header JSON string
   * hash = SHA256(data[16 : 16+N])
   */
  const data = fs.readFileSync(APP_ASAR);
  const stringLength = data.readUInt32LE(12);
  const headerString = data.subarray(16, 16 + stringLength);
  const newHash = crypto.createHash('sha256').update(headerString).digest('hex');
  console.log(`New asar header hash: ${newHash}`);

  // Read Info.plist as JSON using plutil, modify hash, write back as binary plist
  const jsonStr = execFileSync('plutil', ['-convert', 'json', '-o', '-', INFO_PLIST], {
    encoding: 'utf8',
  });
  const plist = JSON.parse(jsonStr) as Record<string, unknown>;
  const integrity = (plist['ElectronAsarIntegrity'] ?? {}) as Record<string, unknown>;
  const asarEntry = (integrity['Resources/app.asar'] ?? {}) as Record<string, unknown>;
  console.log(`Old hash: ${(asarEntry['hash'] as string) ?? '<not found>'}`);

  asarEntry['hash'] = newHash;
  integrity['Resources/app.asar'] = asarEntry;
  plist['ElectronAsarIntegrity'] = integrity;

  const tmpFile = path.join(os.tmpdir(), `notion-plist-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(plist), 'utf8');
    execFileSync('plutil', ['-convert', 'binary1', '-o', INFO_PLIST, tmpFile]);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
  console.log('Info.plist hash updated.');
}

function ensureCustomCss(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (fs.existsSync(CUSTOM_CSS)) {
    console.log(`Custom CSS already exists. Skipping: ${CUSTOM_CSS}`);
    return;
  }
  console.log(`Creating default custom CSS → ${CUSTOM_CSS}`);
  fs.writeFileSync(CUSTOM_CSS, DEFAULT_CSS, 'utf8');
}

function findStableSigningIdentity(): CodeSigningIdentity | null {
  const output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  return parseCodeSigningIdentities(output, SIGNING_IDENTITY_NAME);
}

function getLoginKeychain(): string {
  try {
    return execFileSync('security', ['login-keychain'], { encoding: 'utf8' })
      .trim()
      .replace(/^"|"$/g, '');
  } catch {
    return path.join(os.homedir(), 'Library/Keychains/login.keychain-db');
  }
}

function createStableSigningIdentity(): CodeSigningIdentity {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-font-customizer-signing-'));
  fs.chmodSync(tempDir, 0o700);

  const opensslConfig = path.join(tempDir, 'openssl.cnf');
  const keyFile = path.join(tempDir, 'identity.key');
  const certFile = path.join(tempDir, 'identity.crt');
  const p12File = path.join(tempDir, 'identity.p12');
  const loginKeychain = getLoginKeychain();
  const p12Passphrase = crypto.randomBytes(24).toString('hex');

  try {
    fs.writeFileSync(
      opensslConfig,
      [
        '[req]',
        'prompt = no',
        'distinguished_name = dn',
        'x509_extensions = v3_req',
        '',
        '[dn]',
        `CN = ${SIGNING_IDENTITY_NAME}`,
        '',
        '[v3_req]',
        'basicConstraints = critical, CA:TRUE',
        'keyUsage = critical, digitalSignature',
        'extendedKeyUsage = critical, codeSigning',
        'subjectKeyIdentifier = hash',
        '',
      ].join('\n'),
      'utf8',
    );

    console.log(`Creating local code signing identity: ${SIGNING_IDENTITY_NAME}`);
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-days',
      '3650',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-config',
      opensslConfig,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    execFileSync(
      'openssl',
      buildPkcs12ExportArgs(p12File, keyFile, certFile, SIGNING_IDENTITY_NAME, p12Passphrase),
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    execFileSync('security', buildSecurityImportArgs(p12File, loginKeychain, p12Passphrase), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    execFileSync('security', [
      'add-trusted-cert',
      '-r',
      'trustRoot',
      '-p',
      'codeSign',
      '-k',
      loginKeychain,
      certFile,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer | string };
    console.error(`Failed to create local signing identity: ${err.stderr?.toString() ?? String(e)}`);
    process.exit(1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const identity = findStableSigningIdentity();
  if (!identity) {
    console.error(
      `Error: created signing identity was not found by security find-identity.\n` +
        `Expected identity: ${SIGNING_IDENTITY_NAME}`,
    );
    process.exit(1);
  }
  return identity;
}

function ensureStableSigningIdentity(): CodeSigningIdentity {
  const existing = findStableSigningIdentity();
  if (existing) {
    console.log(`Using local code signing identity: ${existing.name} (${existing.hash})`);
    return existing;
  }
  return createStableSigningIdentity();
}

function resignApp(): void {
  console.log(`\nRemoving quarantine attributes: ${NOTION_APP}`);
  execFileSync('xattr', ['-cr', NOTION_APP]);

  const identity = ensureStableSigningIdentity();
  console.log(`Re-signing ${NOTION_APP} with ${identity.name}...`);
  try {
    execFileSync('codesign', buildCodesignArgs(identity.hash, NOTION_APP), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer | string };
    console.error(`Code signing failed: ${err.stderr?.toString() ?? String(e)}`);
    process.exit(1);
  }
  console.log('Re-signing complete.');
}

function restore(): void {
  migrateLegacyBackups();

  const currentVer = getNotionVersion(INFO_PLIST);
  const backup = getBackupPaths(currentVer);
  if (!fs.existsSync(backup.appAsar)) {
    console.error(`Error: backup file not found. Cannot restore: ${backup.appAsar}`);
    process.exit(1);
  }

  if (fs.existsSync(backup.infoPlist)) {
    const currentVer = getNotionVersion(INFO_PLIST);
    const backupVer = getNotionVersion(backup.infoPlist);
    if (currentVer !== backupVer) {
      console.error(
        `Error: backup version (${backupVer}) does not match current version (${currentVer}).\n` +
          `Notion has been updated; the old backup is no longer valid.\n` +
          `Delete the backup directory and re-run the patcher:\n` +
          `  rm -rf ${backup.dir}\n` +
          `  notion-font-customizer`,
      );
      process.exit(1);
    }
  }

  if (fs.existsSync(APP_DIR)) {
    console.log(`Removing temp directory: ${APP_DIR}`);
    fs.rmSync(APP_DIR, { recursive: true, force: true });
  }

  console.log(`Restoring ${backup.appAsar} → ${APP_ASAR}`);
  fs.copyFileSync(backup.appAsar, APP_ASAR);

  if (fs.existsSync(backup.infoPlist)) {
    console.log(`Restoring ${backup.infoPlist} → ${INFO_PLIST}`);
    fs.copyFileSync(backup.infoPlist, INFO_PLIST);
  } else {
    console.warn(`Warning: Info.plist backup not found. Skipping plist restore: ${backup.infoPlist}`);
  }

  resignApp();
  console.log('Restore complete. Please restart Notion.');
}

function isCurrentAsarPatched(): boolean {
  try {
    const preload = asar.extractFile(APP_ASAR, '.webpack/renderer/tab_browser_view/preload.js').toString('utf8');
    const mainIndex = asar.extractFile(APP_ASAR, '.webpack/main/index.js').toString('utf8');
    return preload.includes(INJECT_MARKER) && mainIndex.includes(INJECT_MAIN_MARKER);
  } catch {
    return false;
  }
}

async function patch(force = false): Promise<void> {
  console.log('=== Notion Font Patcher ===\n');
  migrateLegacyBackups();

  if (!force) {
    const currentVer = getNotionVersion(INFO_PLIST);
    const backup = getBackupPaths(currentVer);
    const action = getPatchAction({
      force,
      backupExists: fs.existsSync(backup.appAsar) && fs.existsSync(backup.infoPlist),
      currentAsarPatched: isCurrentAsarPatched(),
    });
    if (action === 'resign') {
      console.log(
        `Already patched (version ${currentVer}). Ensuring stable local signature.\n` +
          `  Run with --restore to revert, or --force to re-patch asar contents.`,
      );
      ensureCustomCss();
      resignApp();
      return;
    }
  }

  const backup = backupAsar();
  extractAsar(backup);
  injectPreload();
  injectMainProcess();
  await repackAsar();
  updateAsarHash();
  ensureCustomCss();
  resignApp();
  console.log(
    `\nPatch applied!\n` +
      `  Custom CSS: ${CUSTOM_CSS}\n` +
      `  Font changes hot-reload automatically — no restart needed for CSS edits.\n` +
      `  Restart Notion to activate the patch.\n` +
      `\n  Note: re-run this tool after each Notion update.`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const action = parseCliAction(args);

  if (action.kind === 'help') {
    console.log(
      'Usage: notion-font-customizer [--restore] [--force]\n' +
        '       notion-font-customizer --configure-gist --gist-id <id> [--github-token <token>]\n' +
        '       notion-font-customizer --disable-gist\n\n' +
        'Options:\n' +
        '  --restore  Restore original app.asar from backup\n' +
        '  --force    Re-patch even if already patched (useful after updating the patcher)\n' +
        '  --configure-gist  Use notion-stylish.json from a GitHub Gist as the style source\n' +
        '  --gist-id <id>    GitHub Gist ID for --configure-gist\n' +
        '  --github-token <token>  Optional token for authenticated Gist reads\n' +
        '  --disable-gist    Disable the Gist style source and use local custom.css\n' +
        '  --help     Show this help message\n\n' +
        'Examples:\n' +
        '  notion-font-customizer           # Apply patch\n' +
        '  notion-font-customizer --restore  # Restore original state\n' +
        '  notion-font-customizer --force    # Force re-patch current version\n' +
        '  notion-font-customizer --configure-gist --gist-id abc123\n' +
        '  nfc                              # Short alias for apply\n' +
        '  nfc --restore                    # Short alias for restore\n' +
        '  nfc --force                      # Short alias for force re-patch',
    );
    return;
  }

  if (action.kind === 'configure-gist') {
    writeGistConfig(GIST_CONFIG, {
      enabled: true,
      gistId: action.gistId,
      githubToken: action.githubToken,
    });
    console.log(`Gist style source configured: ${GIST_CONFIG}`);
    console.log('GitHub token: stored locally only' + (action.githubToken ? '' : ' (none configured)'));
    return;
  }

  if (action.kind === 'disable-gist') {
    disableGistConfig(GIST_CONFIG);
    console.log(`Gist style source disabled: ${GIST_CONFIG}`);
    return;
  }

  if (action.kind === 'restore') {
    restore();
  } else {
    await patch(action.force);
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;

  try {
    const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
    const entryPath = fs.realpathSync(path.resolve(entry));
    return modulePath === entryPath;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((e: unknown) => {
    console.error(String(e));
    process.exit(1);
  });
}
