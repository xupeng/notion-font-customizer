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

// Paths
const NOTION_APP = '/Applications/Notion.app';
const NOTION_RESOURCES = path.join(NOTION_APP, 'Contents/Resources');
const APP_ASAR = path.join(NOTION_RESOURCES, 'app.asar');
const APP_ASAR_BAK = path.join(NOTION_RESOURCES, 'app.asar.bak');
const APP_ASAR_UNPACKED = path.join(NOTION_RESOURCES, 'app.asar.unpacked');
const APP_DIR = path.join(NOTION_RESOURCES, 'app');
const PRELOAD_JS = path.join(APP_DIR, '.webpack/renderer/tab_browser_view/preload.js');
const MAIN_INDEX_JS = path.join(APP_DIR, '.webpack/main/index.js');

const INFO_PLIST = path.join(NOTION_APP, 'Contents/Info.plist');
const INFO_PLIST_BAK = path.join(NOTION_APP, 'Contents/Info.plist.bak');

const CONFIG_DIR = path.join(os.homedir(), '.config/notion');
const CUSTOM_CSS = path.join(CONFIG_DIR, 'custom.css');

const INJECT_MARKER = '// [notion-custom-font] injected';
const INJECT_MAIN_MARKER = '// [notion-custom-font] main process injected';

const INJECT_JS = `${INJECT_MARKER}
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
      if (css) applyCSS(css);
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

const INJECT_MAIN_JS = `${INJECT_MAIN_MARKER}
;(function() {
  const { ipcMain, webContents } = require('electron');
  const fs = require('fs');
  const path = require('path');
  const cssPath = path.join(
    process.env.HOME || '', '.config', 'notion', 'custom.css'
  );

  function readCSS() {
    try {
      return fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
    } catch (e) { return ''; }
  }

  ipcMain.handle('notion-custom:get-css', () => readCSS());

  // Hot reload: fs.watch → broadcast to all renderers
  try {
    let debounceTimer;
    fs.watch(cssPath, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const css = readCSS();
        webContents.getAllWebContents().forEach(wc => {
          if (!wc.isDestroyed()) wc.send('notion-custom:css-changed', css);
        });
      }, 200);
    });
  } catch (e) {}
})();`;

const DEFAULT_CSS = `/* Notion custom font configuration */
/* Migrated from user's existing Stylus browser styles */

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

/* Body content font */
div.notion-page-content *,
div.notion-page-block *,
div.notion-collection-item *,
div.layout-chat *,
div.chat_sidebar * {
    font-family: "Caecilia LT Std", XinFang, STKaiti, -apple-system,
        BlinkMacSystemFont, "Segoe UI", Helvetica, "Apple Color Emoji",
        Arial, sans-serif, "Segoe UI Emoji", "Segoe UI Symbol" !important;
    line-height: 1.7em !important;
}

/* Heading font */
div.notion-header-block span,
div.notion-header-block div,
div.notion-sub_header-block span,
div.notion-sub_header-block div,
div.notion-page-block span,
div.notion-page-block div,
div.notion-page-block h1,
div.notion-sub_sub_header-block span,
div.notion-sub_sub_header-block div {
    font-family: "Arial Rounded MT Bold", "Caecilia LT Std", "PingFang TC", STKaiti !important;
}

/* Code block font */
div.notion-code-block div span {
    font-family: Consolas, monospace !important;
}
`;

function getNotionVersion(plistPath: string): string {
  return execFileSync(
    'plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plistPath],
    { encoding: 'utf8' },
  ).trim();
}

function backupAsar(): void {
  if (fs.existsSync(APP_ASAR_BAK) && fs.existsSync(INFO_PLIST_BAK)) {
    const currentVer = getNotionVersion(INFO_PLIST);
    const backupVer = getNotionVersion(INFO_PLIST_BAK);
    if (currentVer !== backupVer) {
      console.log(`Detected Notion upgrade from ${backupVer} to ${currentVer}. Refreshing backup...`);
      fs.unlinkSync(APP_ASAR_BAK);
      fs.unlinkSync(INFO_PLIST_BAK);
      // Fall through to create a fresh backup below
    } else {
      console.log(`Backup already exists (version ${currentVer}). Skipping.`);
      return;
    }
  }

  if (!fs.existsSync(APP_ASAR_BAK)) {
    if (!fs.existsSync(APP_ASAR)) {
      console.error(`Error: ${APP_ASAR} not found.`);
      process.exit(1);
    }
    console.log(`Backing up app.asar → ${APP_ASAR_BAK}`);
    fs.copyFileSync(APP_ASAR, APP_ASAR_BAK);
  }

  if (!fs.existsSync(INFO_PLIST_BAK)) {
    if (!fs.existsSync(INFO_PLIST)) {
      console.error(`Error: ${INFO_PLIST} not found.`);
      process.exit(1);
    }
    console.log(`Backing up Info.plist → ${INFO_PLIST_BAK}`);
    fs.copyFileSync(INFO_PLIST, INFO_PLIST_BAK);
  }
}

function extractAsar(): void {
  if (fs.existsSync(APP_DIR)) {
    console.log(`Removing old app/ directory: ${APP_DIR}`);
    fs.rmSync(APP_DIR, { recursive: true, force: true });
  }

  if (!fs.existsSync(APP_ASAR_BAK)) {
    console.error('Error: backup file app.asar.bak not found.');
    process.exit(1);
  }

  // asar looks for <archive>.unpacked/ for native .node files.
  // Since we extract from app.asar.bak, temporarily create a symlink
  // app.asar.bak.unpacked → app.asar.unpacked so the library can find them.
  const bakUnpacked = `${APP_ASAR_BAK}.unpacked`;
  const symlinkCreated =
    fs.existsSync(APP_ASAR_UNPACKED) && !fs.existsSync(bakUnpacked);
  if (symlinkCreated) {
    fs.symlinkSync(path.basename(APP_ASAR_UNPACKED), bakUnpacked);
  }

  try {
    console.log(`Extracting ${path.basename(APP_ASAR_BAK)} → ${APP_DIR}`);
    asar.extractAll(APP_ASAR_BAK, APP_DIR);
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

function resignApp(): void {
  console.log(`\nRemoving quarantine attributes: ${NOTION_APP}`);
  execFileSync('xattr', ['-cr', NOTION_APP]);

  console.log(`Ad-hoc re-signing ${NOTION_APP}...`);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', NOTION_APP], {
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
  if (!fs.existsSync(APP_ASAR_BAK)) {
    console.error('Error: backup file app.asar.bak not found. Cannot restore.');
    process.exit(1);
  }

  if (fs.existsSync(INFO_PLIST_BAK)) {
    const currentVer = getNotionVersion(INFO_PLIST);
    const backupVer = getNotionVersion(INFO_PLIST_BAK);
    if (currentVer !== backupVer) {
      console.error(
        `Error: backup version (${backupVer}) does not match current version (${currentVer}).\n` +
          `Notion has been updated; the old backup is no longer valid.\n` +
          `Delete the backup files and re-run the patcher:\n` +
          `  rm ${APP_ASAR_BAK} ${INFO_PLIST_BAK}\n` +
          `  notion-font-customizer`,
      );
      process.exit(1);
    }
  }

  if (fs.existsSync(APP_DIR)) {
    console.log(`Removing temp directory: ${APP_DIR}`);
    fs.rmSync(APP_DIR, { recursive: true, force: true });
  }

  console.log(`Restoring ${APP_ASAR_BAK} → ${APP_ASAR}`);
  fs.copyFileSync(APP_ASAR_BAK, APP_ASAR);

  if (fs.existsSync(INFO_PLIST_BAK)) {
    console.log(`Restoring ${INFO_PLIST_BAK} → ${INFO_PLIST}`);
    fs.copyFileSync(INFO_PLIST_BAK, INFO_PLIST);
  } else {
    console.warn('Warning: Info.plist.bak not found. Skipping plist restore.');
  }

  resignApp();
  console.log('Restore complete. Please restart Notion.');
}

async function patch(): Promise<void> {
  console.log('=== Notion Font Patcher ===\n');

  // 如果备份存在且版本匹配，说明当前版本已打过补丁
  if (fs.existsSync(APP_ASAR_BAK) && fs.existsSync(INFO_PLIST_BAK)) {
    const currentVer = getNotionVersion(INFO_PLIST);
    const backupVer = getNotionVersion(INFO_PLIST_BAK);
    if (currentVer === backupVer) {
      console.log(
        `Already patched (version ${currentVer}). Nothing to do.\n` +
          `  Run with --restore to revert.`,
      );
      return;
    }
  }

  backupAsar();
  extractAsar();
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

  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: notion-font-customizer [--restore]\n\n' +
        'Options:\n' +
        '  --restore  Restore original app.asar from backup\n' +
        '  --help     Show this help message\n\n' +
        'Examples:\n' +
        '  notion-font-customizer           # Apply patch\n' +
        '  notion-font-customizer --restore  # Restore original state\n' +
        '  nfc                              # Short alias for apply\n' +
        '  nfc --restore                    # Short alias for restore',
    );
    return;
  }

  if (args.includes('--restore')) {
    restore();
  } else {
    await patch();
  }
}

main().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
