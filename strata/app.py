import os
import uuid
import json
import shutil
import subprocess
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory, abort

MEDIA_ROOT = Path(os.environ.get("MEDIA_ROOT", "/media"))
TRACKS_DIR = MEDIA_ROOT / "tracks"
PRESETS_DIR = MEDIA_ROOT / "presets"
DB_PATH = MEDIA_ROOT / "telemetry.db"

app = Flask(__name__, static_folder="static", template_folder="templates")

# ---------------------------------------------------------------------------
# Download job queue (in-memory, lives for the process lifetime)
# ---------------------------------------------------------------------------

_jobs: dict = {}          # job_id → {status, url, track_id, track?, error?}
_jobs_lock = threading.Lock()


def _run_download_job(job_id: str, url: str, track_id: str, track_dir: Path):
    with _jobs_lock:
        _jobs[job_id]["status"] = "running"
    try:
        cmd = [
            "yt-dlp",
            "--extract-audio",
            "--audio-format", "mp3",
            "--audio-quality", "0",
            "--write-thumbnail",
            "--write-info-json",
            "--convert-thumbnails", "jpg",
            "-o", str(track_dir / "track.%(ext)s"),
            url,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(track_dir))
        if result.returncode != 0:
            shutil.rmtree(track_dir, ignore_errors=True)
            with _jobs_lock:
                _jobs[job_id].update({"status": "error", "error": result.stderr[-2000:]})
            return

        src_mp3 = track_dir / "track.mp3"
        if src_mp3.exists():
            src_mp3.rename(track_dir / "audio.mp3")

        info_files = list(track_dir.glob("track.info.json"))
        info = {}
        if info_files:
            info = json.loads(info_files[0].read_text())

        thumb_candidates = list(track_dir.glob("track.jpg")) + list(track_dir.glob("track.webp"))
        thumb_name = None
        if thumb_candidates:
            thumb_src = thumb_candidates[0]
            thumb_dest = track_dir / "thumbnail.jpg"
            if thumb_src != thumb_dest:
                thumb_src.rename(thumb_dest)
            thumb_name = "thumbnail.jpg"

        segments = []
        for ch in (info.get("chapters") or []):
            title = (ch.get("title") or "").strip()
            start = ch.get("start_time", 0)
            end   = ch.get("end_time",   0)
            if title and end > start:
                segments.append({"name": title, "start": round(start, 2), "end": round(end, 2)})

        meta = {
            "id": track_id,
            "title": info.get("title", "Unknown"),
            "source_url": url,
            "source_channel": info.get("uploader") or info.get("channel"),
            "thumbnail": thumb_name,
            "duration_seconds": info.get("duration"),
            "date_added": datetime.now(timezone.utc).isoformat(),
            "mood_tags": [],
            "segments": segments,
        }
        save_metadata(track_id, meta)

        with _jobs_lock:
            _jobs[job_id].update({"status": "done", "track": meta})

    except Exception as exc:
        shutil.rmtree(track_dir, ignore_errors=True)
        with _jobs_lock:
            _jobs[job_id].update({"status": "error", "error": str(exc)})


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

def ensure_dirs():
    TRACKS_DIR.mkdir(parents=True, exist_ok=True)
    PRESETS_DIR.mkdir(parents=True, exist_ok=True)


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS play_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                track_id    TEXT    NOT NULL,
                started_at  TEXT    NOT NULL,
                ended_at    TEXT,
                segment_name TEXT,
                source      TEXT
            )
        """)


def _purge_orphan_events():
    """Remove play_events whose track folder no longer exists."""
    if not TRACKS_DIR.exists():
        return
    existing = {d.name for d in TRACKS_DIR.iterdir() if d.is_dir()}
    with get_db() as conn:
        if existing:
            placeholders = ",".join("?" * len(existing))
            conn.execute(
                f"DELETE FROM play_events WHERE track_id NOT IN ({placeholders})",
                list(existing),
            )
        else:
            conn.execute("DELETE FROM play_events")


def _schedule_daily_cleanup():
    """Purge orphan events once per day in the background."""
    _purge_orphan_events()
    t = threading.Timer(86400, _schedule_daily_cleanup)
    t.daemon = True
    t.start()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_metadata(track_id: str) -> dict | None:
    path = TRACKS_DIR / track_id / "metadata.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


def save_metadata(track_id: str, meta: dict):
    (TRACKS_DIR / track_id).mkdir(parents=True, exist_ok=True)
    (TRACKS_DIR / track_id / "metadata.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False)
    )


def all_tracks() -> list[dict]:
    tracks = []
    for d in sorted(TRACKS_DIR.iterdir()):
        if d.is_dir():
            meta = load_metadata(d.name)
            if meta:
                tracks.append(meta)
    return tracks


# ---------------------------------------------------------------------------
# Serve frontend
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(app.template_folder, "index.html")


# ---------------------------------------------------------------------------
# Track endpoints
# ---------------------------------------------------------------------------

@app.route("/api/tracks", methods=["GET"])
def list_tracks():
    return jsonify(all_tracks())


@app.route("/api/tracks/<track_id>", methods=["GET"])
def get_track(track_id):
    meta = load_metadata(track_id)
    if not meta:
        abort(404)
    return jsonify(meta)


@app.route("/api/tracks/<track_id>", methods=["POST"])
def update_track(track_id):
    meta = load_metadata(track_id)
    if not meta:
        abort(404)
    body = request.get_json(force=True)
    for field in ("title", "mood_tags", "segments", "source_channel", "custom_label"):
        if field in body:
            meta[field] = body[field]
    save_metadata(track_id, meta)
    return jsonify(meta)


@app.route("/api/tracks/<track_id>", methods=["DELETE"])
def delete_track(track_id):
    track_dir = TRACKS_DIR / track_id
    if not track_dir.exists():
        abort(404)
    shutil.rmtree(track_dir)
    with get_db() as conn:
        conn.execute("DELETE FROM play_events WHERE track_id = ?", (track_id,))
    return jsonify({"deleted": track_id})


@app.route("/api/admin/cleanup", methods=["POST"])
def cleanup_orphans():
    """Delete play_events rows whose track folder no longer exists."""
    with get_db() as conn:
        before = conn.execute("SELECT COUNT(*) FROM play_events").fetchone()[0]
    _purge_orphan_events()
    with get_db() as conn:
        after = conn.execute("SELECT COUNT(*) FROM play_events").fetchone()[0]
    return jsonify({"deleted_events": before - after})


@app.route("/api/admin/repair", methods=["POST"])
def repair_tracks():
    """Reconstruct metadata.json for track folders that have audio but no metadata.
    Covers downloads that completed but lost their metadata due to the old code."""
    repaired, skipped, failed = [], [], []

    if not TRACKS_DIR.exists():
        return jsonify({"repaired": 0, "skipped": 0, "failed": []})

    for track_dir in TRACKS_DIR.iterdir():
        if not track_dir.is_dir():
            continue
        track_id = track_dir.name

        if (track_dir / "metadata.json").exists():
            skipped.append(track_id)
            continue

        if not (track_dir / "audio.mp3").exists():
            failed.append({"id": track_id, "reason": "no audio.mp3"})
            continue

        # Read info JSON (may be named audio.info.json or track.info.json)
        info = {}
        for info_file in track_dir.glob("*.info.json"):
            try:
                info = json.loads(info_file.read_text())
                break
            except Exception:
                pass

        # Normalize thumbnail: pick first jpg/webp, rename to thumbnail.jpg
        thumb_name = None
        for ext in ("jpg", "jpeg", "webp", "png"):
            candidates = list(track_dir.glob(f"*.{ext}"))
            if candidates:
                src = candidates[0]
                dest = track_dir / "thumbnail.jpg"
                if src != dest:
                    src.rename(dest)
                thumb_name = "thumbnail.jpg"
                break

        # Remove raw video files left behind by yt-dlp
        for raw in list(track_dir.glob("*.webm")) + list(track_dir.glob("*.mp4")):
            raw.unlink(missing_ok=True)

        meta = {
            "id": track_id,
            "title": info.get("title") or track_id[:12],
            "source_url": info.get("webpage_url") or info.get("original_url"),
            "source_channel": info.get("uploader") or info.get("channel"),
            "thumbnail": thumb_name,
            "duration_seconds": info.get("duration"),
            "date_added": datetime.now(timezone.utc).isoformat(),
            "mood_tags": [],
            "segments": [],
            "custom_label": None,
        }

        try:
            save_metadata(track_id, meta)
            repaired.append(track_id)
        except Exception as exc:
            failed.append({"id": track_id, "reason": str(exc)})

    return jsonify({"repaired": len(repaired), "skipped": len(skipped), "failed": failed})


# Serve audio and thumbnails for a track
@app.route("/api/tracks/<track_id>/audio")
def serve_audio(track_id):
    return send_from_directory(TRACKS_DIR / track_id, "audio.mp3")


@app.route("/api/tracks/<track_id>/thumbnail")
def serve_thumbnail(track_id):
    thumb = TRACKS_DIR / track_id / "thumbnail.jpg"
    if not thumb.exists():
        abort(404)
    return send_from_directory(TRACKS_DIR / track_id, "thumbnail.jpg")


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------

@app.route("/api/upload", methods=["POST"])
def upload_track():
    if "file" not in request.files:
        return jsonify({"error": "no file"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "empty filename"}), 400

    track_id = str(uuid.uuid4())
    track_dir = TRACKS_DIR / track_id
    track_dir.mkdir(parents=True)

    audio_path = track_dir / "audio.mp3"
    f.save(audio_path)

    title = Path(f.filename).stem
    meta = {
        "id": track_id,
        "title": title,
        "source_url": None,
        "source_channel": None,
        "thumbnail": None,
        "duration_seconds": None,
        "date_added": datetime.now(timezone.utc).isoformat(),
        "mood_tags": [],
        "segments": [],
    }
    save_metadata(track_id, meta)
    return jsonify(meta), 201


# ---------------------------------------------------------------------------
# yt-dlp download
# ---------------------------------------------------------------------------

@app.route("/api/download", methods=["POST"])
def download_track():
    body = request.get_json(force=True)
    url = body.get("url", "").strip()
    if not url:
        return jsonify({"error": "url required"}), 400

    job_id = str(uuid.uuid4())
    track_id = str(uuid.uuid4())
    track_dir = TRACKS_DIR / track_id
    track_dir.mkdir(parents=True)

    with _jobs_lock:
        _jobs[job_id] = {"status": "queued", "url": url, "track_id": track_id}

    threading.Thread(
        target=_run_download_job,
        args=(job_id, url, track_id, track_dir),
        daemon=True,
    ).start()

    return jsonify({"job_id": job_id}), 202


@app.route("/api/jobs", methods=["GET"])
def list_jobs():
    with _jobs_lock:
        return jsonify({jid: dict(j) for jid, j in _jobs.items()})


@app.route("/api/jobs/<job_id>", methods=["GET"])
def get_job(job_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        abort(404)
    return jsonify(job)


# ---------------------------------------------------------------------------
# Presets
# ---------------------------------------------------------------------------

@app.route("/api/presets", methods=["GET"])
def list_presets():
    presets = []
    for p in sorted(PRESETS_DIR.glob("*.json")):
        presets.append(json.loads(p.read_text()))
    return jsonify(presets)


@app.route("/api/presets", methods=["POST"])
def save_preset():
    body = request.get_json(force=True)
    name = body.get("name", "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    preset = {
        "name": name,
        "created": datetime.now(timezone.utc).isoformat(),
        "tracks": body.get("tracks", []),
    }
    safe_name = "".join(c for c in name if c.isalnum() or c in " _-").strip()
    path = PRESETS_DIR / f"{safe_name}.json"
    path.write_text(json.dumps(preset, indent=2, ensure_ascii=False))
    return jsonify(preset), 201


@app.route("/api/presets/<preset_name>", methods=["DELETE"])
def delete_preset(preset_name):
    for p in PRESETS_DIR.glob("*.json"):
        data = json.loads(p.read_text())
        if data.get("name") == preset_name:
            p.unlink()
            return jsonify({"deleted": preset_name})
    abort(404)


# ---------------------------------------------------------------------------
# Telemetry
# ---------------------------------------------------------------------------

@app.route("/api/telemetry/event", methods=["POST"])
def record_event():
    body = request.get_json(force=True)
    track_id = body.get("track_id")
    started_at = body.get("started_at")
    if not track_id or not started_at:
        return jsonify({"error": "track_id and started_at required"}), 400
    with get_db() as conn:
        conn.execute(
            "INSERT INTO play_events (track_id, started_at, ended_at, segment_name, source) VALUES (?,?,?,?,?)",
            (
                track_id,
                started_at,
                body.get("ended_at"),
                body.get("segment_name"),
                body.get("source"),
            ),
        )
    return jsonify({"ok": True}), 201


@app.route("/api/telemetry/stats", methods=["GET"])
def telemetry_stats():
    with get_db() as conn:
        # Most played by count
        top_count = conn.execute("""
            SELECT track_id, COUNT(*) as play_count
            FROM play_events
            GROUP BY track_id
            ORDER BY play_count DESC
            LIMIT 10
        """).fetchall()

        # Most played by total minutes (only rows with ended_at)
        top_minutes = conn.execute("""
            SELECT track_id,
                   ROUND(SUM((JULIANDAY(ended_at) - JULIANDAY(started_at)) * 86400) / 60.0, 1) as total_minutes
            FROM play_events
            WHERE ended_at IS NOT NULL
            GROUP BY track_id
            ORDER BY total_minutes DESC
            LIMIT 10
        """).fetchall()

        # Recently played (distinct tracks)
        recent = conn.execute("""
            SELECT track_id, MAX(started_at) as last_played
            FROM play_events
            GROUP BY track_id
            ORDER BY last_played DESC
            LIMIT 10
        """).fetchall()

        # Total listening time all / 7d / 30d
        def listening_minutes(days=None):
            clause = ""
            if days:
                clause = f"WHERE started_at >= datetime('now', '-{days} days')"
            row = conn.execute(f"""
                SELECT ROUND(SUM((JULIANDAY(ended_at) - JULIANDAY(started_at)) * 86400) / 60.0, 1)
                FROM play_events
                WHERE ended_at IS NOT NULL
                {("AND started_at >= datetime('now', '-" + str(days) + " days')") if days else ""}
            """).fetchone()
            return row[0] or 0

    return jsonify({
        "total_minutes": {
            "all_time": listening_minutes(),
            "last_7d": listening_minutes(7),
            "last_30d": listening_minutes(30),
        },
        "top_by_count": [dict(r) for r in top_count],
        "top_by_minutes": [dict(r) for r in top_minutes],
        "recently_played": [dict(r) for r in recent],
    })


# ---------------------------------------------------------------------------
# Per-track telemetry
# ---------------------------------------------------------------------------

@app.route("/api/telemetry/track/<track_id>", methods=["GET"])
def track_stats(track_id):
    with get_db() as conn:
        row = conn.execute("""
            SELECT
                COUNT(*) as play_count,
                ROUND(SUM(CASE WHEN ended_at IS NOT NULL
                    THEN (JULIANDAY(ended_at) - JULIANDAY(started_at)) * 86400 / 60.0
                    ELSE 0 END), 1) as total_minutes,
                MAX(started_at) as last_played
            FROM play_events
            WHERE track_id = ?
        """, (track_id,)).fetchone()
    return jsonify(dict(row))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    ensure_dirs()
    init_db()
    app.run(host="0.0.0.0", port=5000, debug=False)
