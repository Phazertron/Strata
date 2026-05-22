# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for Strata desktop app.
#
# Build from the repo root:
#   pyinstaller desktop/build/strata.spec
#
# Output: dist/Strata/  (Windows/Linux)  or  dist/Strata.app  (macOS)
#
# Before building:
#   1. Place icon.png (256x256 RGBA) and icon.ico in desktop/assets/
#   2. On macOS also place icon.icns in desktop/assets/
#   3. Ensure yt-dlp and ffmpeg binaries are in desktop/assets/bin/
#      (they will be copied next to the exe and added to PATH at runtime)

import sys
from pathlib import Path

ROOT    = Path(SPECPATH).parent.parent          # repo root
STRATA  = ROOT / "strata"
DESKTOP = ROOT / "desktop"
ASSETS  = DESKTOP / "assets"
BIN     = ASSETS / "bin"                        # yt-dlp, ffmpeg

# Collect external binaries if present
extra_binaries = []
for name in ("yt-dlp", "yt-dlp.exe", "ffmpeg", "ffmpeg.exe",
             "ffprobe", "ffprobe.exe"):
    p = BIN / name
    if p.exists():
        extra_binaries.append((str(p), "bin"))

block_cipher = None

a = Analysis(
    [str(DESKTOP / "main.py")],
    pathex=[str(STRATA)],
    binaries=extra_binaries,
    datas=[
        (str(ASSETS),            "assets"),
        (str(STRATA / "templates"), "strata/templates"),
        (str(STRATA / "static"),    "strata/static"),
        (str(STRATA / "app.py"),    "strata"),
        (str(STRATA / "wsgi.py"),   "strata"),
    ],
    hiddenimports=[
        # pystray backends — PyInstaller can't detect these automatically
        "pystray._win32",
        "pystray._darwin",
        "pystray._xorg",
        # Flask internals
        "flask",
        "jinja2",
        "jinja2.ext",
        "werkzeug",
        "werkzeug.serving",
        "werkzeug.routing",
        # waitress
        "waitress",
        "waitress.adjustments",
        "waitress.server",
        # Pillow
        "PIL",
        "PIL.Image",
        "PIL.PngImagePlugin",
        # stdlib used by app
        "sqlite3",
        "email.mime.text",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy", "pandas"],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Strata",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,          # no terminal window
    icon=str(ASSETS / "icon.ico"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="Strata",
)

# macOS: wrap in a .app bundle with LSUIElement=True (no Dock icon)
if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="Strata.app",
        icon=str(ASSETS / "icon.icns"),
        bundle_identifier="com.strata.desktop",
        info_plist={
            "CFBundleName": "Strata",
            "CFBundleShortVersionString": "1.0.0",
            "CFBundleVersion": "1",
            "NSHighResolutionCapable": True,
            "LSUIElement": True,        # hide from Dock, menu-bar only
            "NSAppleEventsUsageDescription": "Strata uses AppleEvents to open the browser.",
        },
    )
