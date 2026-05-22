"""
Strata desktop wrapper — system tray (Windows) / menu bar (macOS)

Starts the Flask server in a background thread via waitress, then runs a
native tray icon. Double-clicking or selecting "Open" opens the app in the
default browser. Quit stops the process cleanly.
"""
import os
import sys
import socket
import threading
import time
import webbrowser

import pystray
from PIL import Image


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _app_root() -> str:
    """Absolute path to the strata/ Flask package."""
    if getattr(sys, "frozen", False):           # PyInstaller bundle
        return os.path.join(sys._MEIPASS, "strata")
    return os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "strata"))


def _user_data_dir() -> str:
    """Per-user data directory — holds tracks, presets, and the SQLite DB."""
    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support")
    elif sys.platform == "win32":
        base = os.environ.get("APPDATA", os.path.expanduser("~"))
    else:
        base = os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share"))
    path = os.path.join(base, "Strata")
    os.makedirs(path, exist_ok=True)
    return path


def _asset(name: str) -> str:
    """Resolve an asset path whether running frozen or from source."""
    if getattr(sys, "frozen", False):
        return os.path.join(sys._MEIPASS, "assets", name)
    return os.path.join(os.path.dirname(__file__), "assets", name)


# ---------------------------------------------------------------------------
# Port selection
# ---------------------------------------------------------------------------

def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


PORT = _find_free_port()


# ---------------------------------------------------------------------------
# Flask / waitress server
# ---------------------------------------------------------------------------

def _start_server() -> None:
    """Initialise the Flask app and start waitress. Runs in a daemon thread."""
    # Point MEDIA_ROOT at the user data directory before importing the app
    os.environ["MEDIA_ROOT"] = _user_data_dir()

    root = _app_root()
    if root not in sys.path:
        sys.path.insert(0, root)

    from app import app, ensure_dirs, init_db, _schedule_daily_cleanup  # noqa: PLC0415
    ensure_dirs()
    init_db()
    _schedule_daily_cleanup()

    from waitress import serve  # noqa: PLC0415
    serve(app, host="127.0.0.1", port=PORT, threads=4)


def _wait_for_server(timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


# ---------------------------------------------------------------------------
# Tray icon
# ---------------------------------------------------------------------------

def _open_browser(_icon: pystray.Icon, _item: pystray.MenuItem) -> None:
    webbrowser.open(f"http://127.0.0.1:{PORT}")


def _quit_app(icon: pystray.Icon, _item: pystray.MenuItem) -> None:
    icon.stop()
    os._exit(0)     # forcibly terminate waitress daemon threads


def _build_tray() -> pystray.Icon:
    image = Image.open(_asset("icon.png"))
    menu = pystray.Menu(
        pystray.MenuItem("Open Strata", _open_browser, default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", _quit_app),
    )
    return pystray.Icon("Strata", image, "Strata", menu)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    # Start Flask in a background daemon thread
    threading.Thread(target=_start_server, daemon=True, name="strata-server").start()

    # Wait until the server is accepting connections
    if not _wait_for_server():
        # If we timed out, still open the browser — user will see an error page
        # rather than a silent failure, which is easier to diagnose
        pass

    # Open the browser on first launch
    webbrowser.open(f"http://127.0.0.1:{PORT}")

    # Hand control to pystray — blocks until _quit_app calls icon.stop()
    _build_tray().run()


if __name__ == "__main__":
    main()
