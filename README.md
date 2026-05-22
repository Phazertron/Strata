# Strata

A self-hosted ambient sound mixer for layering music, soundscapes, and audio tracks in a browser. Designed for focus, sleep, or background listening sessions.

## Features

- **Beds zone** — multiple tracks loop simultaneously, each with independent volume
- **Queue zone** — tracks play in sequence with drag-to-reorder, a master volume, and optional looping
- **Library** — browse by All / By Channel / By Mood, sort by date, title, or play count
- **YouTube / URL download** — paste any URL, yt-dlp fetches audio + thumbnail in the background
- **Auto-segmentation** — chapters from yt-dlp and tracklist timestamps from descriptions are parsed automatically
- **Manual segments** — add, edit, and reorder segments in the track editor; paste a tracklist text to auto-generate them
- **Mood tags** — tag tracks with comma-separated moods; autocomplete from your existing tag corpus
- **Presets** — save and restore full mixer states (beds + queue + volumes); mark one as the default on startup
- **Stats** — listening time (all time / 30 days / 7 days), most played, most listened by time, recently played
- **Segment bar** — visual timeline of segments in the mixer; hover any chip for an instant name + time preview

## Disclaimer

Strata is a personal-use tool. You are responsible for ensuring that any audio you download complies with the terms of service of the source platform and applicable copyright law. The authors make no representations regarding the legality of downloading specific content.

## Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, Flask 3, Gunicorn (gthread) |
| Audio download | yt-dlp + ffmpeg |
| Frontend | Vanilla JS, Web Audio API |
| Storage | Flat files (JSON metadata + mp3 + thumbnail) + SQLite (telemetry) |
| Container | Docker, linux/arm64 |
| Reverse proxy | Traefik |

## Project structure

```
strata/                 # Flask app (shared by both deployment targets)
├── app.py              # Flask API + download jobs + DB telemetry
├── wsgi.py             # Gunicorn entry point (Docker)
├── requirements.txt
├── Dockerfile
├── templates/
│   └── index.html      # Single-page app shell
└── static/
    ├── css/style.css
    └── js/app.js       # All UI logic (mixer, library, modals, audio engine)
desktop/                # Native desktop wrapper (tray / menu-bar app)
├── main.py             # pystray entry point, starts waitress server
├── requirements.txt
├── README.md           # Desktop build guide
├── assets/
│   ├── generate_icon.py
│   └── bin/            # Place yt-dlp + ffmpeg binaries here for bundling
└── build/
    ├── strata.spec     # PyInstaller spec (Windows + macOS)
    └── installer.iss   # Inno Setup script (Windows installer wizard)
docker-compose.yml
```

Media is stored outside the container and mounted at `/media`:

```
/media/
├── tracks/
│   └── <uuid>/
│       ├── audio.mp3
│       ├── thumbnail.jpg
│       └── meta.json
├── presets/
│   └── <name>.json
└── telemetry.db
```

## Running locally

### Desktop app (system tray / menu bar)

The easiest way to run Strata on a personal machine — starts a local server and adds a tray icon with an **Open** shortcut.

```bash
pip install -r strata/requirements.txt   # skip gunicorn errors on Windows/macOS
pip install -r desktop/requirements.txt
python desktop/assets/generate_icon.py   # once, to create icons
python desktop/main.py
```

See [desktop/README.md](desktop/README.md) for building a distributable installer.

### Flask dev server (no tray icon)

```bash
cd strata
pip install -r requirements.txt
# ffmpeg and yt-dlp must be on PATH
MEDIA_ROOT=./media flask run
```

## Deploying with Docker Compose

The `docker-compose.yml` is written for a homelab running Traefik as a reverse proxy. Adjust the `Host` labels and volume path to match your setup.

```bash
# build and start
docker compose up -d --build

# view logs
docker compose logs -f strata
```

The container expects a `TZ` environment variable (e.g. in a `.env` file):

```
TZ=Europe/Rome
```

The media volume must be writable by the container process. On the reference deployment it maps `/mnt/raid/strata/media` → `/media`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MEDIA_ROOT` | `/media` | Root path for tracks, presets, and telemetry DB |
| `TZ` | — | Timezone for timestamp display |
| `FLASK_ENV` | `production` | Set to `development` for debug mode locally |

## API routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tracks` | List all tracks |
| `POST` | `/api/tracks` | Upload an audio file |
| `PATCH` | `/api/tracks/<id>` | Update track metadata |
| `DELETE` | `/api/tracks/<id>` | Delete track and all its files |
| `GET` | `/api/tracks/<id>/thumbnail` | Serve thumbnail image |
| `GET` | `/api/tracks/<id>/audio` | Serve audio file |
| `POST` | `/api/download` | Queue a yt-dlp download job |
| `GET` | `/api/jobs/<id>` | Poll a download job's status |
| `GET` | `/api/presets` | List saved presets |
| `POST` | `/api/presets` | Save a preset |
| `DELETE` | `/api/presets/<name>` | Delete a preset |
| `GET` | `/api/stats` | Listening time and play-count stats |
| `POST` | `/api/telemetry` | Record a play event |

## Segment auto-detection

When a video is downloaded, segments are built from (in order of preference):

1. **yt-dlp native chapters** — from the video's chapter markers
2. **Description parsing** — timestamps found anywhere in each line; supports formats like `[00:00]`, `00:00`, `01:01:30`, with or without leading track numbers and URLs on the same line

If description parsing yields more segments than native chapters, it wins. You can also paste a tracklist manually in the track editor and click **Parse**.

## Notes

- The same track can be added to the Queue multiple times (each gets a unique slot)
- YouTube URLs are cleaned to `?v=VIDEO_ID` only before download to avoid accidental playlist fetches; `--no-playlist` is also passed to yt-dlp
- Telemetry (play events) is stored locally in SQLite and purged of orphaned entries once per day
