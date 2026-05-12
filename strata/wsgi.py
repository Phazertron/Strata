from app import app, ensure_dirs, init_db, _schedule_daily_cleanup

ensure_dirs()
init_db()
_schedule_daily_cleanup()   # purge orphan telemetry once a day

application = app
