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
strata/
├── app.py              # Flask API + download jobs + DB telemetry
├── wsgi.py             # Gunicorn entry point
├── requirements.txt
├── Dockerfile
├── templates/
│   └── index.html      # Single-page app shell
└── static/
    ├── css/style.css
    └── js/app.js       # All UI logic (mixer, library, modals, audio engine)
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

```bash
cd strata
pip install -r requirements.txt
# ffmpeg must be installed separately
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
