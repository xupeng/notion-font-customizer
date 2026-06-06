# notion-font-customizer

[中文](README.zh-CN.md)

Custom font patcher for the macOS Notion desktop app.
Injects CSS hot-reload into Notion's Electron asar bundle,
allowing live font customization without restarting.

## Features

- Extracts and patches Notion's `app.asar`
- Injects CSS hot-reload via Electron IPC
- Watches `~/.config/notion/custom.css` for live changes
- Can read the same `notion-stylish.json` GitHub Gist used by notion-stylish
- Re-signs the app bundle with a stable local code signing identity
- Supports clean restore to original state

## Requirements

- macOS
- Node.js >= 18

## Usage

### One-shot (no install)

```bash
npx github:xupeng/notion-font-customizer          # Apply patch
npx github:xupeng/notion-font-customizer --restore  # Restore original
npx github:xupeng/notion-font-customizer --configure-gist --gist-id abc123
```

### Global install

```bash
npm install -g github:xupeng/notion-font-customizer
notion-font-customizer          # Apply patch
notion-font-customizer --restore  # Restore original
notion-font-customizer --configure-gist --gist-id abc123
nfc                              # Short alias for apply
nfc --restore                    # Short alias for restore
```

## How It Works

1. Backs up `app.asar` and `Info.plist` outside the app bundle
2. Extracts the asar, injects IPC code into `preload.js` and `main/index.js`
3. Repacks the asar, updates the header hash in `Info.plist`
4. Re-signs `Notion.app` with a stable local code signing identity
5. Creates a default `custom.css` at `~/.config/notion/custom.css`

Edit `custom.css` to change fonts — changes apply instantly via hot-reload.

## GitHub Gist Style Source

To reuse the same style source as `notion-stylish`, configure the Gist ID:

```bash
notion-font-customizer --configure-gist --gist-id abc123
```

The tool reads `notion-stylish.json` from that Gist when Notion starts. The
GitHub token is optional for this read-only mode:

```bash
notion-font-customizer --configure-gist --gist-id abc123 --github-token ghp_xxx
```

The config is stored at `~/.config/notion/gist.json` with local-only file
permissions. The token is never written to the cache. A valid remote snapshot is
cached at `~/.config/notion/gist-cache.json`, and the local `custom.css` is used
as fallback if neither the remote nor the cache is available.

Disable the Gist source and return to local `custom.css` hot-reload mode:

```bash
notion-font-customizer --disable-gist
```

## Google Fonts

Google Fonts work out of the box — CSP is relaxed and preconnect hints are injected automatically.

1. Find a font on [fonts.google.com](https://fonts.google.com) and copy its `@import` URL.
2. Add it to `~/.config/notion/custom.css`:

```css
@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700&display=swap');

div.notion-page-content * {
    font-family: 'Noto Serif SC', serif !important;
}
```

Changes hot-reload instantly — no restart needed.

## After Notion Updates

Re-run the patcher. The tool detects version changes and refreshes backups automatically.

The first run creates a local self-signed code signing identity named
`Notion Font Customizer Local Code Signing` in your login keychain. Notion is
still no longer signed by its original developer certificate after patching,
but the local identity is reused across future patch and restore runs on the
same Mac.

## License

MIT
