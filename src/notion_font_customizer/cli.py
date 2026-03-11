"""
Notion Custom Font Patcher

Features:
  - Extracts Notion app.asar and injects custom CSS hot-reload code into preload.js
  - Supports --restore to revert to the original app.asar

Usage:
  notion-font-customizer          # Apply patch
  notion-font-customizer --restore  # Restore original state
"""

import argparse
import hashlib
import plistlib
import shutil
import struct
import subprocess
import sys
from pathlib import Path

NOTION_APP = Path("/Applications/Notion.app")
NOTION_RESOURCES = NOTION_APP / "Contents/Resources"
APP_ASAR = NOTION_RESOURCES / "app.asar"
APP_ASAR_BAK = NOTION_RESOURCES / "app.asar.bak"
APP_ASAR_UNPACKED = NOTION_RESOURCES / "app.asar.unpacked"
APP_ASAR_BAK_UNPACKED = NOTION_RESOURCES / "app.asar.bak.unpacked"
APP_DIR = NOTION_RESOURCES / "app"
PRELOAD_JS = APP_DIR / ".webpack/renderer/tab_browser_view/preload.js"
MAIN_INDEX_JS = APP_DIR / ".webpack/main/index.js"

INFO_PLIST = NOTION_APP / "Contents/Info.plist"
INFO_PLIST_BAK = NOTION_APP / "Contents/Info.plist.bak"

CONFIG_DIR = Path.home() / ".config/notion"
CUSTOM_CSS = CONFIG_DIR / "custom.css"

INJECT_MARKER = "// [notion-custom-font] injected"
INJECT_MAIN_MARKER = "// [notion-custom-font] main process injected"

INJECT_JS = f"""\
{INJECT_MARKER}
;(function() {{
  const {{ ipcRenderer }} = require('electron');
  const STYLE_ID = 'notion-custom-font';

  function applyCSS(css) {{
    let style = document.getElementById(STYLE_ID);
    if (!style) {{
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }}
    style.textContent = css;
  }}

  async function loadInitialCSS() {{
    try {{
      const css = await ipcRenderer.invoke('notion-custom:get-css');
      if (css) applyCSS(css);
    }} catch (e) {{ console.error('[notion-custom-font]', e); }}
  }}

  ipcRenderer.on('notion-custom:css-changed', (_event, css) => {{
    applyCSS(css);
  }});

  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', loadInitialCSS);
  }} else {{
    loadInitialCSS();
  }}
}})();
"""

INJECT_MAIN_JS = f"""\
{INJECT_MAIN_MARKER}
;(function() {{
  const {{ ipcMain, webContents }} = require('electron');
  const fs = require('fs');
  const path = require('path');
  const cssPath = path.join(
    process.env.HOME || '', '.config', 'notion', 'custom.css'
  );

  function readCSS() {{
    try {{
      return fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
    }} catch (e) {{ return ''; }}
  }}

  ipcMain.handle('notion-custom:get-css', () => readCSS());

  // Hot reload: fs.watch → broadcast to all renderers
  try {{
    let debounceTimer;
    fs.watch(cssPath, () => {{
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {{
        const css = readCSS();
        webContents.getAllWebContents().forEach(wc => {{
          if (!wc.isDestroyed()) wc.send('notion-custom:css-changed', css);
        }});
      }}, 200);
    }});
  }} catch (e) {{}}
}})();
"""

DEFAULT_CSS = """\
/* Notion custom font configuration */
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
"""


def _get_notion_version(plist_path: Path) -> str:
    """Read Notion version from Info.plist."""
    with open(plist_path, "rb") as f:
        plist = plistlib.load(f)
    return plist.get("CFBundleShortVersionString", "unknown")


def check_npx_asar() -> None:
    """Check that npx and asar are available."""
    if shutil.which("npx") is None:
        print("Error: npx not found. Please install Node.js first.", file=sys.stderr)
        sys.exit(1)
    # Quick check that asar is callable via npx
    result = subprocess.run(
        ["npx", "--yes", "asar", "--version"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print("Error: npx asar is not available. Check your network or npm configuration.", file=sys.stderr)
        sys.exit(1)


def backup_asar() -> None:
    """Back up app.asar and Info.plist (only on first run or version change)."""
    # Detect whether the backup needs refreshing (stale after a Notion upgrade)
    if APP_ASAR_BAK.exists() and INFO_PLIST_BAK.exists():
        current_ver = _get_notion_version(INFO_PLIST)
        backup_ver = _get_notion_version(INFO_PLIST_BAK)
        if current_ver != backup_ver:
            print(f"Detected Notion upgrade from {backup_ver} to {current_ver}. Refreshing backup...")
            APP_ASAR_BAK.unlink()
            INFO_PLIST_BAK.unlink()
            # Fall through to create a fresh backup below
        else:
            print(f"Backup already exists (version {current_ver}). Skipping.")
            return

    # Back up app.asar
    if not APP_ASAR_BAK.exists():
        if not APP_ASAR.exists():
            print(f"Error: {APP_ASAR} not found.", file=sys.stderr)
            sys.exit(1)
        print(f"Backing up app.asar → {APP_ASAR_BAK}")
        shutil.copy2(APP_ASAR, APP_ASAR_BAK)

    # Back up Info.plist
    if not INFO_PLIST_BAK.exists():
        if not INFO_PLIST.exists():
            print(f"Error: {INFO_PLIST} not found.", file=sys.stderr)
            sys.exit(1)
        print(f"Backing up Info.plist → {INFO_PLIST_BAK}")
        shutil.copy2(INFO_PLIST, INFO_PLIST_BAK)


def extract_asar() -> None:
    """Extract app.asar from backup into app/ directory (always from unmodified original)."""
    if APP_DIR.exists():
        print(f"Removing old app/ directory: {APP_DIR}")
        shutil.rmtree(APP_DIR)

    if not APP_ASAR_BAK.exists():
        print("Error: backup file app.asar.bak not found.", file=sys.stderr)
        sys.exit(1)

    # asar extract automatically looks for <source>.unpacked/ for native .node files.
    # The backup is named app.asar.bak, so the tool looks for app.asar.bak.unpacked/.
    # Create a temporary symlink pointing to the real app.asar.unpacked/ directory.
    symlink_created = False
    if APP_ASAR_UNPACKED.exists() and not APP_ASAR_BAK_UNPACKED.exists():
        APP_ASAR_BAK_UNPACKED.symlink_to(APP_ASAR_UNPACKED.name)
        symlink_created = True

    print(f"Extracting {APP_ASAR_BAK.name} → {APP_DIR}")
    try:
        result = subprocess.run(
            ["npx", "--yes", "asar", "extract", str(APP_ASAR_BAK), str(APP_DIR)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(f"Extraction failed: {result.stderr}", file=sys.stderr)
            sys.exit(1)
    finally:
        if symlink_created and APP_ASAR_BAK_UNPACKED.is_symlink():
            APP_ASAR_BAK_UNPACKED.unlink()


def inject_preload() -> None:
    """Inject CSS hot-reload code into preload.js."""
    if not PRELOAD_JS.exists():
        print(f"Error: preload.js not found: {PRELOAD_JS}", file=sys.stderr)
        sys.exit(1)

    content = PRELOAD_JS.read_text(encoding="utf-8")

    if INJECT_MARKER in content:
        print("preload.js already contains injected code. Skipping.")
        return

    print(f"Injecting CSS hot-reload code → {PRELOAD_JS}")
    PRELOAD_JS.write_text(content + "\n" + INJECT_JS, encoding="utf-8")


def inject_main_process() -> None:
    """Inject IPC handler code into main process index.js."""
    if not MAIN_INDEX_JS.exists():
        print(f"Error: main/index.js not found: {MAIN_INDEX_JS}", file=sys.stderr)
        sys.exit(1)

    content = MAIN_INDEX_JS.read_text(encoding="utf-8")

    if INJECT_MAIN_MARKER in content:
        print("main/index.js already contains injected code. Skipping.")
        return

    print(f"Injecting IPC handler code → {MAIN_INDEX_JS}")
    MAIN_INDEX_JS.write_text(content + "\n" + INJECT_MAIN_JS, encoding="utf-8")


def repack_asar() -> None:
    """Repack modified app/ directory into app.asar and clean up temp directory."""
    print(f"Repacking {APP_DIR} → {APP_ASAR}")
    result = subprocess.run(
        [
            "npx", "--yes", "asar", "pack",
            str(APP_DIR), str(APP_ASAR),
            "--unpack", "**/*.node",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"Pack failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    print(f"Cleaning up temp directory: {APP_DIR}")
    shutil.rmtree(APP_DIR)


def update_asar_hash() -> None:
    """Compute new app.asar header hash and update Info.plist.

    asar file format:
      Byte 0-3:   pickle payload size (uint32 LE)
      Byte 4-7:   header buffer length (uint32 LE)
      Byte 8-11:  header pickle payload size (uint32 LE)
      Byte 12-15: header string length (uint32 LE) → N
      Byte 16 ~ 16+N: header JSON string
    hash = SHA256(data[16 : 16+N])
    """
    data = APP_ASAR.read_bytes()
    string_length = struct.unpack("<I", data[12:16])[0]
    header_string = data[16 : 16 + string_length]
    new_hash = hashlib.sha256(header_string).hexdigest()
    print(f"New asar header hash: {new_hash}")

    with open(INFO_PLIST, "rb") as f:
        plist = plistlib.load(f)

    integrity = plist.get("ElectronAsarIntegrity", {})
    asar_entry = integrity.get("Resources/app.asar", {})
    old_hash = asar_entry.get("hash", "<not found>")
    print(f"Old hash: {old_hash}")

    asar_entry["hash"] = new_hash
    integrity["Resources/app.asar"] = asar_entry
    plist["ElectronAsarIntegrity"] = integrity

    with open(INFO_PLIST, "wb") as f:
        plistlib.dump(plist, f)
    print("Info.plist hash updated.")


def ensure_custom_css() -> None:
    """Create default custom.css if it does not exist."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if CUSTOM_CSS.exists():
        print(f"Custom CSS already exists. Skipping: {CUSTOM_CSS}")
        return
    print(f"Creating default custom CSS → {CUSTOM_CSS}")
    CUSTOM_CSS.write_text(DEFAULT_CSS, encoding="utf-8")


def resign_app() -> None:
    """Ad-hoc re-sign Notion.app to fix code signature validation."""
    app_path = str(NOTION_APP)
    print(f"\nRemoving quarantine attributes: {app_path}")
    subprocess.run(["xattr", "-cr", app_path], check=True)

    print(f"Ad-hoc re-signing {app_path}...")
    result = subprocess.run(
        ["codesign", "--force", "--deep", "--sign", "-", app_path],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"Code signing failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    print("Re-signing complete.")


def restore() -> None:
    """Restore original app.asar and Info.plist from backup."""
    if not APP_ASAR_BAK.exists():
        print("Error: backup file app.asar.bak not found. Cannot restore.", file=sys.stderr)
        sys.exit(1)

    # Version check: prevent overwriting a newer Notion with an old backup
    if INFO_PLIST_BAK.exists():
        current_ver = _get_notion_version(INFO_PLIST)
        backup_ver = _get_notion_version(INFO_PLIST_BAK)
        if current_ver != backup_ver:
            print(
                f"Error: backup version ({backup_ver}) does not match current version ({current_ver}).\n"
                f"Notion has been updated; the old backup is no longer valid.\n"
                f"Delete the backup files and re-run the patcher:\n"
                f"  sudo rm {APP_ASAR_BAK} {INFO_PLIST_BAK}\n"
                f"  sudo notion-font-customizer",
                file=sys.stderr,
            )
            sys.exit(1)

    if APP_DIR.exists():
        print(f"Removing temp directory: {APP_DIR}")
        shutil.rmtree(APP_DIR)

    print(f"Restoring {APP_ASAR_BAK} → {APP_ASAR}")
    shutil.copy2(APP_ASAR_BAK, APP_ASAR)

    if INFO_PLIST_BAK.exists():
        print(f"Restoring {INFO_PLIST_BAK} → {INFO_PLIST}")
        shutil.copy2(INFO_PLIST_BAK, INFO_PLIST)
    else:
        print("Warning: Info.plist.bak not found. Skipping plist restore.", file=sys.stderr)

    resign_app()
    print("Restore complete. Please restart Notion.")


def patch() -> None:
    """Apply patch: extract asar, inject code, repack, update hash, re-sign."""
    print("=== Notion Font Patcher ===\n")
    check_npx_asar()
    backup_asar()          # Back up app.asar + Info.plist
    extract_asar()         # Extract from backup, leaving original asar intact
    inject_preload()       # Inject preload IPC client code
    inject_main_process()  # Inject main process IPC handler code
    repack_asar()          # Repack into app.asar + remove temp directory
    update_asar_hash()     # Update asar header hash in Info.plist
    ensure_custom_css()
    resign_app()           # Remove quarantine attributes + ad-hoc re-sign
    print(
        f"\nPatch applied!\n"
        f"  Custom CSS: {CUSTOM_CSS}\n"
        f"  Font changes hot-reload automatically — no restart needed for CSS edits.\n"
        f"  Restart Notion to activate the patch.\n"
        f"\n  Note: re-run this tool after each Notion update."
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Notion custom font patcher",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  notion-font-customizer           # Apply patch\n"
            "  notion-font-customizer --restore  # Restore original state\n"
            "  nfc                              # Short alias for apply\n"
            "  nfc --restore                    # Short alias for restore"
        ),
    )
    parser.add_argument(
        "--restore",
        action="store_true",
        help="Restore original app.asar from backup",
    )
    args = parser.parse_args()

    if args.restore:
        restore()
    else:
        patch()


if __name__ == "__main__":
    main()
