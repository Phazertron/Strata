# Strata — Desktop app

Runs Strata as a native system-tray app (Windows) or menu-bar app (macOS) with no terminal window. The Flask server starts automatically in the background; clicking **Open Strata** launches the UI in your default browser.

User data (tracks, presets, database) is stored in:
- **Windows** — `%APPDATA%\Strata\`
- **macOS** — `~/Library/Application Support/Strata/`

---

## Development (run without building)

```bash
# 1 — install dependencies (do this once)
pip install -r strata/requirements.txt
pip install -r desktop/requirements.txt

# 2 — generate placeholder icons (do this once)
python desktop/assets/generate_icon.py

# 3 — run
python desktop/main.py
```

---

## Building a distributable

### Prerequisites (both platforms)

| Tool | Version | Notes |
|------|---------|-------|
| Python | 3.11+ | Must match target platform |
| PyInstaller | 6.x | `pip install pyinstaller` |
| Pillow | 10.x | `pip install Pillow` |
| pystray | 0.19.x | `pip install pystray` |
| waitress | 3.x | `pip install waitress` |

Place `yt-dlp` and `ffmpeg`/`ffprobe` binaries in `desktop/assets/bin/`:
- Windows: `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`
- macOS: `yt-dlp`, `ffmpeg`, `ffprobe` (chmod +x)

These are bundled into the executable so end users don't need to install them.

### 1 — Generate icons

```bash
python desktop/assets/generate_icon.py
```

Replace the generated files with your final artwork before publishing:
- `desktop/assets/icon.png` — 256×256 RGBA
- `desktop/assets/icon.ico` — multi-size ICO (Windows)
- `desktop/assets/icon.icns` — ICNS bundle (macOS)

### 2 — Build with PyInstaller

Run from the **repo root**:

```bash
pyinstaller desktop/build/strata.spec
```

Output:
- `dist/Strata/` — folder with the executable (Windows / Linux)
- `dist/Strata.app` — app bundle (macOS)

### 3a — Windows installer (Inno Setup)

1. Install [Inno Setup](https://jrsoftware.org/isdl.php)
2. Run:
   ```
   iscc desktop\build\installer.iss
   ```
3. Installer appears at `dist/installer/Strata-Setup-1.0.0.exe`

The installer:
- Installs per-user (no admin required)
- Optionally adds to Windows startup
- Optionally creates a desktop shortcut
- Leaves user data intact on uninstall

### 3b — macOS distribution

```bash
# Codesign (requires Apple Developer ID — skip for personal use)
codesign --deep --force --verify --verbose \
  --sign "Developer ID Application: Your Name (TEAMID)" \
  dist/Strata.app

# Create a drag-to-Applications DMG
hdiutil create -volname "Strata" -srcfolder dist/Strata.app \
  -ov -format UDZO dist/Strata.dmg
```

Without signing, macOS will show a Gatekeeper warning on first launch.
Users can bypass it via **System Settings → Privacy & Security → Open Anyway**,
or by running: `xattr -cr /Applications/Strata.app`

---

## How it works

```
main.py
 ├── _find_free_port()        picks a random available port
 ├── _start_server()          sets MEDIA_ROOT, imports Flask app,
 │                            starts waitress on 127.0.0.1:<port>
 ├── _wait_for_server()       polls until the server responds
 ├── webbrowser.open(...)     opens the UI in the default browser
 └── pystray icon             runs the event loop; Quit calls os._exit(0)
```

The Flask app (`strata/`) is **unchanged** — the desktop wrapper is purely a
packaging and launch concern.

---

## Updating the version

Edit the version string in two places:
1. `desktop/build/strata.spec` → `CFBundleShortVersionString` (macOS)
2. `desktop/build/installer.iss` → `#define AppVersion`
