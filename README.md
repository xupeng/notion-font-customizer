# notion-font-customizer

Custom font patcher for the macOS Notion desktop app.
Injects CSS hot-reload into Notion's Electron asar bundle,
allowing live font customization without restarting.

## Features

- Extracts and patches Notion's `app.asar`
- Injects CSS hot-reload via Electron IPC
- Watches `~/.config/notion/custom.css` for live changes
- Ad-hoc re-signs the app bundle
- Supports clean restore to original state

## Requirements

- macOS
- Python 3.10+
- Node.js (`npx` + `asar`)
- `uv` (recommended)

## Installation

```bash
uv tool install .
# or: pip install .
```

## Usage

> `sudo` may be needed to write to `/Applications`.

```bash
sudo notion-font-customizer          # Apply patch
sudo notion-font-customizer --restore  # Restore original
sudo nfc                              # Short alias for apply
sudo nfc --restore                    # Short alias for restore
```

## How It Works

1. Backs up `app.asar` and `Info.plist`
2. Extracts the asar, injects IPC code into `preload.js` and `main/index.js`
3. Repacks the asar, updates the header hash in `Info.plist`
4. Re-signs `Notion.app` (ad-hoc)
5. Creates a default `custom.css` at `~/.config/notion/custom.css`

Edit `custom.css` to change fonts — changes apply instantly via hot-reload.

## After Notion Updates

Re-run the patcher. The tool detects version changes and refreshes backups automatically.

## License

MIT
