"""Работа с базой SQLite (файл gym.db рядом с кодом)."""
import json
import os
import sqlite3

from catalog_seed import SEED, V1_COUNT

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("GYM_DB", os.path.join(BASE_DIR, "gym.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    height REAL,
    goal TEXT NOT NULL DEFAULT 'hypertrophy',
    freq INTEGER NOT NULL DEFAULT 3,
    injuries TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    used_by INTEGER REFERENCES users(id),
    used_at TEXT
);
CREATE TABLE IF NOT EXISTS measurements (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    weight REAL NOT NULL,
    fat_pct REAL,
    muscle_kg REAL,
    bmr REAL
);
CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    equipment TEXT NOT NULL DEFAULT '',
    muscle TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    helpers TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    region TEXT NOT NULL,
    stress TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    photo TEXT
);
CREATE TABLE IF NOT EXISTS workouts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
);
CREATE TABLE IF NOT EXISTS sets (
    id INTEGER PRIMARY KEY,
    workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    set_no INTEGER NOT NULL,
    weight REAL NOT NULL DEFAULT 0,
    reps INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sets_workout ON sets(workout_id);
CREATE INDEX IF NOT EXISTS idx_workouts_user ON workouts(user_id, status);
"""


def connect(path=None):
    conn = sqlite3.connect(path or DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn):
    conn.executescript(SCHEMA)
    # Обновление старой базы: колонка для фото появилась во второй версии
    cols = {r[1] for r in conn.execute("PRAGMA table_info(exercises)")}
    if "photo" not in cols:
        conn.execute("ALTER TABLE exercises ADD COLUMN photo TEXT")
    # Стартовый каталог. Каждое упражнение из SEED добавляется один раз:
    # новые версии приложения дополняют каталог, но не возвращают то,
    # что вы уже переименовали, и не трогают ваши правки.
    conn.execute("CREATE TABLE IF NOT EXISTS seeded (name TEXT PRIMARY KEY)")
    seeded = {r[0] for r in conn.execute("SELECT name FROM seeded")}
    existing = {r[0] for r in conn.execute("SELECT name FROM exercises")}
    if not seeded and existing:
        # База от первой версии: её стартовые упражнения уже были добавлены
        seeded = {e["name"] for e in SEED[:V1_COUNT]}
        conn.executemany("INSERT INTO seeded (name) VALUES (?)",
                         [(n,) for n in seeded])
    for e in SEED:
        if e["name"] in seeded:
            continue
        if e["name"] not in existing:
            save_exercise(conn, e)
        conn.execute("INSERT INTO seeded (name) VALUES (?)", (e["name"],))
    conn.commit()


def exercise_to_dict(row):
    d = dict(row)
    d["stress"] = json.loads(d["stress"] or "[]")
    d["active"] = bool(d["active"])
    d["photo_url"] = ("/static/photos/" + d["photo"]) if d.get("photo") else None
    return d


def save_exercise(conn, e, ex_id=None):
    values = (e["name"], e.get("equipment", ""), e["muscle"],
              e.get("target", ""), e.get("helpers", ""), e["kind"],
              e["region"], json.dumps(e.get("stress", [])),
              1 if e.get("active", True) else 0)
    if ex_id is None:
        cur = conn.execute(
            "INSERT INTO exercises (name, equipment, muscle, target, helpers,"
            " kind, region, stress, active) VALUES (?,?,?,?,?,?,?,?,?)", values)
        return cur.lastrowid
    conn.execute(
        "UPDATE exercises SET name=?, equipment=?, muscle=?, target=?,"
        " helpers=?, kind=?, region=?, stress=?, active=? WHERE id=?",
        values + (ex_id,))
    return ex_id


def all_exercises(conn):
    rows = conn.execute("SELECT * FROM exercises ORDER BY name").fetchall()
    return [exercise_to_dict(r) for r in rows]


def last_sets(conn, user_id):
    """{exercise_id: [(вес, повторы), ...]} — с последней тренировки,
    где это упражнение выполнялось."""
    rows = conn.execute(
        """
        SELECT s.exercise_id, s.weight, s.reps, s.workout_id
        FROM sets s JOIN workouts w ON w.id = s.workout_id
        WHERE w.user_id = ? AND w.status = 'done'
          AND s.workout_id = (
              SELECT w2.id FROM workouts w2 JOIN sets s2 ON s2.workout_id = w2.id
              WHERE w2.user_id = ? AND w2.status = 'done'
                AND s2.exercise_id = s.exercise_id
              ORDER BY w2.date DESC, w2.id DESC LIMIT 1)
        ORDER BY s.set_no
        """, (user_id, user_id)).fetchall()
    out = {}
    for r in rows:
        out.setdefault(r["exercise_id"], []).append((r["weight"], r["reps"]))
    return out


def recent_exercise_ids(conn, user_id, workouts=2):
    """Упражнения из последних выполненных тренировок."""
    rows = conn.execute(
        """
        SELECT DISTINCT exercise_id FROM sets WHERE workout_id IN (
            SELECT id FROM workouts WHERE user_id = ? AND status = 'done'
            ORDER BY date DESC, id DESC LIMIT ?)
        """, (user_id, workouts)).fetchall()
    return [r[0] for r in rows]
