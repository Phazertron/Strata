import os
import re
import uuid
import json
import shutil
import subprocess
import sqlite3
import threading
import collections
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory, abort

MEDIA_ROOT  = Path(os.environ.get("MEDIA_ROOT", "/media"))
TRACKS_DIR  = MEDIA_ROOT / "tracks"
PRESETS_DIR = MEDIA_ROOT / "presets"
DB_PATH     = MEDIA_ROOT / "telemetry.db"
SETTINGS_PATH = MEDIA_ROOT / "settings.json"

DEFAULT_SETTINGS = {"audio_quality": "192k"}

app = Flask(__name__, static_folder="static", template_folder="templates")

# ---------------------------------------------------------------------------
# Download job queue (in-memory, lives for the process lifetime)
# ---------------------------------------------------------------------------

_jobs: dict = {}          # job_id → {status, url, track_id, track?, error?}
_jobs_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Log buffer (ring buffer, last 200 entries)
# ---------------------------------------------------------------------------

_log_buf  = collections.deque(maxlen=200)
_log_lock = threading.Lock()


def _log(msg: str):
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    with _log_lock:
        _log_buf.append(f"[{ts}] {msg}")


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def load_settings() -> dict:
    if SETTINGS_PATH.exists():
        try:
            return {**DEFAULT_SETTINGS, **json.loads(SETTINGS_PATH.read_text())}
        except Exception:
            pass
    return dict(DEFAULT_SETTINGS)


def _save_settings(s: dict):
    MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(s, indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# URL / description helpers
# ---------------------------------------------------------------------------

_TS_RE  = re.compile(r'\b(\d{1,2}:\d{2}(?::\d{2})?)\b')
_URL_RE = re.compile(r'https?://\S+')
_NUM_RE = re.compile(r'^\d+[.)]\s*')


def _clean_url(url: str) -> str:
    """Strip YouTube playlist/radio params — keep only the video ID."""
    try:
        p = urllib.parse.urlparse(url)
        if p.hostname in ("www.youtube.com", "youtube.com", "m.youtube.com"):
            qs = urllib.parse.parse_qs(p.query)
            if "v" in qs:
                return f"https://www.youtube.com/watch?v={qs['v'][0]}"
    except Exception:
        pass
    return url


def _parse_description_chapters(description: str, total_duration: float | None) -> list[dict]:
    """Extract chapter/segment info from a video description's timestamp lines."""
    candidates = []
    for line in description.splitlines():
        line = line.strip()
        if not line:
            continue
        m = _TS_RE.search(line)
        if not m:
            continue
        ts_str = m.group(1)
        parts  = ts_str.split(":")
        try:
            if len(parts) == 2:
                secs = int(parts[0]) * 60 + int(parts[1])
            else:
                secs = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        except (ValueError, IndexError):
            continue

        before = line[:m.start()].strip()
        before = _URL_RE.sub("", before).strip()
        before = _NUM_RE.sub("", before).strip(" -–·•[]()")

        after = line[m.end():].strip()
        after = _URL_RE.sub("", after).strip(" -–·•[]()")
        after = _NUM_RE.sub("", after).strip(" -–·•[]()")

        title = before or after
        if not title:
            title = f"Part {len(candidates) + 1}"
        candidates.append({"start": secs, "title": title})

    if len(candidates) < 2:
        return []

    candidates.sort(key=lambda x: x["start"])
    segments = []
    for i, ch in enumerate(candidates):
        end = candidates[i + 1]["start"] if i + 1 < len(candidates) else (total_duration or ch["start"] + 600)
        if end > ch["start"]:
            segments.append({"name": ch["title"], "start": round(ch["start"], 2), "end": round(end, 2)})
    return segments


# ---------------------------------------------------------------------------
# Download jobs
# ---------------------------------------------------------------------------

def _run_download_job(job_id: str, url: str, track_id: str, track_dir: Path):
    with _jobs_lock:
        _jobs[job_id]["status"] = "running"
    _log(f"Download started: {url}")
    try:
        settings = load_settings()
        quality  = settings.get("audio_quality", "192k")
        cmd = [
            "yt-dlp",
            "--no-playlist",
            "--extract-audio",
            "--audio-format", "m4a",
            "--audio-quality", "0",
            "--postprocessor-args", f"ffmpeg:-b:a {quality}",
            "--write-thumbnail",
            "--write-info-json",
            "--convert-thumbnails", "jpg",
            "-o", str(track_dir / "track.%(ext)s"),
            url,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(track_dir))
        if result.returncode != 0:
            shutil.rmtree(track_dir, ignore_errors=True)
            _log(f"Download failed: {url} — {result.stderr[-200:]}")
            with _jobs_lock:
                _jobs[job_id].update({"status": "error", "error": result.stderr[-2000:]})
            return

        for _ext in ("m4a", "mp3"):
            _src = track_dir / f"track.{_ext}"
            if _src.exists():
                _src.rename(track_dir / f"audio.{_ext}")
                break

        info_files = list(track_dir.glob("track.info.json"))
        info = {}
        if info_files:
            info = json.loads(info_files[0].read_text())

        thumb_candidates = list(track_dir.glob("track.jpg")) + list(track_dir.glob("track.webp"))
        thumb_name = None
        if thumb_candidates:
            thumb_src  = thumb_candidates[0]
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

        if info.get("description"):
            desc_segs = _parse_description_chapters(info["description"], info.get("duration"))
            if len(desc_segs) > len(segments):
                segments = desc_segs

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
        _log(f"Download complete: {meta['title']}")

        with _jobs_lock:
            _jobs[job_id].update({"status": "done", "track": meta})

    except Exception as exc:
        shutil.rmtree(track_dir, ignore_errors=True)
        _log(f"Download error: {exc}")
        with _jobs_lock:
            _jobs[job_id].update({"status": "error", "error": str(exc)})


def _run_repair_job(job_id: str, url: str, track_id: str, track_dir: Path):
    """Re-download audio for a track whose file went missing.
    Preserves existing metadata, segments, and custom thumbnail on failure."""
    with _jobs_lock:
        _jobs[job_id]["status"] = "running"
    _log(f"Repair download started: {url}")
    try:
        settings = load_settings()
        quality  = settings.get("audio_quality", "192k")
        cmd = [
            "yt-dlp",
            "--no-playlist",
            "--extract-audio",
            "--audio-format", "m4a",
            "--audio-quality", "0",
            "--postprocessor-args", f"ffmpeg:-b:a {quality}",
            "-o", str(track_dir / "track.%(ext)s"),
            url,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(track_dir))
        if result.returncode != 0:
            _log(f"Repair failed for {track_id}: {result.stderr[-200:]}")
            with _jobs_lock:
                _jobs[job_id].update({"status": "error", "error": result.stderr[-2000:]})
            return

        for _ext in ("m4a", "mp3"):
            _src = track_dir / f"track.{_ext}"
            if _src.exists():
                _src.rename(track_dir / f"audio.{_ext}")
                break

        meta = load_metadata(track_id) or {}
        _log(f"Repair complete: {meta.get('title', track_id)}")
        with _jobs_lock:
            _jobs[job_id].update({"status": "done", "track": meta})

    except Exception as exc:
        _log(f"Repair error for {track_id}: {exc}")
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


def _has_audio(track_id: str) -> bool:
    d = TRACKS_DIR / track_id
    return (d / "audio.m4a").exists() or (d / "audio.mp3").exists()


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
    tracks = all_tracks()
    for t in tracks:
        tid = t["id"]
        t["has_audio"]            = _has_audio(tid)
        t["has_custom_thumbnail"] = (TRACKS_DIR / tid / "custom_thumbnail.jpg").exists()
    return jsonify(tracks)


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
    if "mood_tags" in body:
        meta["mood_tags"] = [t.strip().lower() for t in (meta["mood_tags"] or []) if t.strip()]
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
    """Reconstruct metadata.json for track folders that have audio but no metadata."""
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

        info = {}
        for info_file in track_dir.glob("*.info.json"):
            try:
                info = json.loads(info_file.read_text())
                break
            except Exception:
                pass

        thumb_name = None
        for ext in ("jpg", "jpeg", "webp", "png"):
            candidates = list(track_dir.glob(f"*.{ext}"))
            if candidates:
                src  = candidates[0]
                dest = track_dir / "thumbnail.jpg"
                if src != dest:
                    src.rename(dest)
                thumb_name = "thumbnail.jpg"
                break

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


@app.route("/api/admin/sanity", methods=["POST"])
def sanity_check():
    """Scan the library for audio issues without deleting anything.

    - Missing audio + YouTube source  → enqueue a repair download job
    - Missing audio + no source URL   → flag for user (returned as missing_no_source)
    - .mp3 present but no .m4a        → enqueue serialised conversion
    """
    redownloading, converting, missing_no_source = [], [], []
    redownloading_ids = []

    if not TRACKS_DIR.exists():
        return jsonify({"redownloading": 0, "converting": 0, "missing_no_source": []})

    for track_dir in TRACKS_DIR.iterdir():
        if not track_dir.is_dir():
            continue
        track_id = track_dir.name
        meta = load_metadata(track_id)
        if not meta:
            continue

        m4a = track_dir / "audio.m4a"
        mp3 = track_dir / "audio.mp3"

        if not m4a.exists() and not mp3.exists():
            source_url = meta.get("source_url", "") or ""
            if "youtube.com" in source_url or "youtu.be" in source_url:
                job_id = str(uuid.uuid4())
                with _jobs_lock:
                    _jobs[job_id] = {"status": "queued", "url": source_url,
                                     "track_id": track_id, "repair": True}
                threading.Thread(
                    target=_run_repair_job,
                    args=(job_id, source_url, track_id, track_dir),
                    daemon=True,
                ).start()
                redownloading.append(track_id)
                redownloading_ids.append(track_id)
                _log(f"Sanity: queued repair for '{meta.get('title', track_id)}'")
            else:
                missing_no_source.append(track_id)
                _log(f"Sanity: '{meta.get('title', track_id)}' has no audio and no YouTube source")

        elif mp3.exists() and not m4a.exists():
            _enqueue_conversion(track_id, mp3, m4a)
            converting.append(track_id)
            _log(f"Sanity: queued MP3→M4A for '{meta.get('title', track_id)}'")

    return jsonify({
        "redownloading":     len(redownloading),
        "redownloading_ids": redownloading_ids,
        "converting":        len(converting),
        "missing_no_source": missing_no_source,
    })


# ---------------------------------------------------------------------------
# Background MP3 → M4A conversion (serialised — one ffmpeg at a time on Pi)
# ---------------------------------------------------------------------------

_converting: set = set()
_convert_queue: list = []
_convert_lock = threading.Lock()
_convert_running = False


def _conversion_worker():
    """Drain the conversion queue one track at a time."""
    global _convert_running
    while True:
        with _convert_lock:
            if not _convert_queue:
                _convert_running = False
                return
            track_id, mp3, m4a = _convert_queue.pop(0)

        settings = load_settings()
        quality  = settings.get("audio_quality", "192k")
        _log(f"Conversion started: {track_id} ({quality})")
        tmp = m4a.with_name("audio.tmp.m4a")
        try:
            r = subprocess.run(
                ["ffmpeg", "-y", "-i", str(mp3),
                 "-c:a", "aac", "-b:a", quality,
                 "-movflags", "+faststart", str(tmp)],
                capture_output=True, timeout=600,
            )
            if r.returncode == 0 and tmp.exists():
                tmp.rename(m4a)
                mp3.unlink(missing_ok=True)
                _log(f"Conversion complete: {track_id}")
            else:
                _log(f"Conversion failed: {track_id}")
        except Exception as exc:
            _log(f"Conversion error: {track_id} — {exc}")
        finally:
            tmp.unlink(missing_ok=True)
            with _convert_lock:
                _converting.discard(track_id)


def _enqueue_conversion(track_id: str, mp3: Path, m4a: Path):
    global _convert_running
    with _convert_lock:
        if track_id in _converting:
            return
        _converting.add(track_id)
        _convert_queue.append((track_id, mp3, m4a))
        if not _convert_running:
            _convert_running = True
            threading.Thread(target=_conversion_worker, daemon=True).start()


# ---------------------------------------------------------------------------
# Audio + thumbnail serving
# ---------------------------------------------------------------------------

@app.route("/api/tracks/<track_id>/audio")
def serve_audio(track_id):
    m4a = TRACKS_DIR / track_id / "audio.m4a"
    mp3 = TRACKS_DIR / track_id / "audio.mp3"
    if m4a.exists():
        return send_from_directory(TRACKS_DIR / track_id, "audio.m4a")
    if mp3.exists():
        _enqueue_conversion(track_id, mp3, m4a)
        return send_from_directory(TRACKS_DIR / track_id, "audio.mp3")
    abort(404)


@app.route("/api/tracks/<track_id>/thumbnail")
def serve_thumbnail(track_id):
    # Custom thumbnail takes priority over the original one
    custom = TRACKS_DIR / track_id / "custom_thumbnail.jpg"
    if custom.exists():
        return send_from_directory(TRACKS_DIR / track_id, "custom_thumbnail.jpg")
    thumb = TRACKS_DIR / track_id / "thumbnail.jpg"
    if not thumb.exists():
        abort(404)
    return send_from_directory(TRACKS_DIR / track_id, "thumbnail.jpg")


@app.route("/api/tracks/<track_id>/thumbnail/custom", methods=["POST"])
def upload_custom_thumbnail(track_id):
    if not (TRACKS_DIR / track_id).exists():
        abort(404)
    if "file" not in request.files:
        return jsonify({"error": "no file"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "empty filename"}), 400
    dest = TRACKS_DIR / track_id / "custom_thumbnail.jpg"
    f.save(str(dest))
    _log(f"Custom thumbnail uploaded for {track_id}")
    return jsonify({"ok": True})


@app.route("/api/tracks/<track_id>/thumbnail/custom", methods=["DELETE"])
def delete_custom_thumbnail(track_id):
    path = TRACKS_DIR / track_id / "custom_thumbnail.jpg"
    if path.exists():
        path.unlink()
        _log(f"Custom thumbnail removed for {track_id}")
    return jsonify({"ok": True})


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

    track_id  = str(uuid.uuid4())
    track_dir = TRACKS_DIR / track_id
    track_dir.mkdir(parents=True)

    audio_path = track_dir / "audio.mp3"
    f.save(audio_path)
    _enqueue_conversion(track_id, audio_path, track_dir / "audio.m4a")

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
    _log(f"Uploaded: {title}")
    return jsonify(meta), 201


# ---------------------------------------------------------------------------
# yt-dlp download
# ---------------------------------------------------------------------------

@app.route("/api/download", methods=["POST"])
def download_track():
    body = request.get_json(force=True)
    url  = _clean_url(body.get("url", "").strip())
    if not url:
        return jsonify({"error": "url required"}), 400

    job_id    = str(uuid.uuid4())
    track_id  = str(uuid.uuid4())
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
# Settings
# ---------------------------------------------------------------------------

@app.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify(load_settings())


@app.route("/api/settings", methods=["POST"])
def update_settings():
    body = request.get_json(force=True)
    s = load_settings()
    for k in ("audio_quality",):
        if k in body:
            s[k] = body[k]
    _save_settings(s)
    _log(f"Settings updated: audio_quality={s.get('audio_quality')}")
    return jsonify(s)


# ---------------------------------------------------------------------------
# Logs + conversion status
# ---------------------------------------------------------------------------

@app.route("/api/logs", methods=["GET"])
def get_logs():
    with _log_lock:
        return jsonify(list(_log_buf))


@app.route("/api/conversions", methods=["GET"])
def get_conversions():
    with _convert_lock:
        return jsonify({
            "running":        _convert_running,
            "queued":         len(_convert_queue),
            "converting_ids": list(_converting),
        })


# ---------------------------------------------------------------------------
# Telemetry
# ---------------------------------------------------------------------------

@app.route("/api/telemetry/event", methods=["POST"])
def record_event():
    body = request.get_json(force=True)
    track_id   = body.get("track_id")
    started_at = body.get("started_at")
    if not track_id or not started_at:
        return jsonify({"error": "track_id and started_at required"}), 400
    with get_db() as conn:
        conn.execute(
            "INSERT INTO play_events (track_id, started_at, ended_at, segment_name, source) VALUES (?,?,?,?,?)",
            (track_id, started_at, body.get("ended_at"), body.get("segment_name"), body.get("source")),
        )
    return jsonify({"ok": True}), 201


@app.route("/api/telemetry/stats", methods=["GET"])
def telemetry_stats():
    with get_db() as conn:
        top_count = conn.execute("""
            SELECT track_id, COUNT(*) as play_count
            FROM play_events GROUP BY track_id ORDER BY play_count DESC LIMIT 10
        """).fetchall()

        top_minutes = conn.execute("""
            SELECT track_id,
                   ROUND(SUM((JULIANDAY(ended_at) - JULIANDAY(started_at)) * 86400) / 60.0, 1) as total_minutes
            FROM play_events WHERE ended_at IS NOT NULL
            GROUP BY track_id ORDER BY total_minutes DESC LIMIT 10
        """).fetchall()

        recent = conn.execute("""
            SELECT track_id, MAX(started_at) as last_played
            FROM play_events GROUP BY track_id ORDER BY last_played DESC LIMIT 10
        """).fetchall()

        def listening_minutes(days=None):
            row = conn.execute(f"""
                SELECT ROUND(SUM((JULIANDAY(ended_at) - JULIANDAY(started_at)) * 86400) / 60.0, 1)
                FROM play_events WHERE ended_at IS NOT NULL
                {("AND started_at >= datetime('now', '-" + str(days) + " days')") if days else ""}
            """).fetchone()
            return row[0] or 0

    return jsonify({
        "total_minutes": {
            "all_time":  listening_minutes(),
            "last_7d":   listening_minutes(7),
            "last_30d":  listening_minutes(30),
        },
        "top_by_count":     [dict(r) for r in top_count],
        "top_by_minutes":   [dict(r) for r in top_minutes],
        "recently_played":  [dict(r) for r in recent],
    })


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
            FROM play_events WHERE track_id = ?
        """, (track_id,)).fetchone()
    return jsonify(dict(row))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    ensure_dirs()
    init_db()
    _log("Strata started")
    app.run(host="0.0.0.0", port=5000, debug=False)
