from app import app, ensure_dirs, init_db

ensure_dirs()
init_db()

application = app
