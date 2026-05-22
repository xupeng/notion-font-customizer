# notion-font-customizer

[中文](README.zh-CN.md)

Custom font patcher for the macOS Notion desktop app.
Injects CSS hot-reload into Notion's Electron asar bundle,
allowing live font customization without restarting.

## Features

- Extracts and patches Notion's `app.asar`
- Injects CSS hot-reload via Electron IPC
- Watches `~/.config/notion/custom.css` for live changes
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
```

### Global install

```bash
npm install -g github:xupeng/notion-font-customizer
notion-font-customizer          # Apply patch
notion-font-customizer --restore  # Restore original
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
