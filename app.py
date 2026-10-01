"""Сервер приложения «Тренер для зала» (Flask)."""
import json
import os
import re
import secrets
from datetime import date, timedelta
from functools import wraps

from flask import Flask, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

import db
import planner

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")


def load_secret_key():
    """Секретный ключ для подписи cookie. Создаётся один раз и хранится
    в файле secret_key.txt (его нет в GitHub)."""
    path = os.path.join(BASE_DIR, "secret_key.txt")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip()


app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.config.update(
    SECRET_KEY=load_secret_key(),
    PERMANENT_SESSION_LIFETIME=timedelta(days=180),
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("GYM_INSECURE_COOKIE") != "1",
    JSON_AS_ASCII=False,
)
app.json.ensure_ascii = False
app.json.sort_keys = False

_conn = db.connect()
db.init_db(_conn)
_conn.close()


# ---------- служебное ----------

def get_db():
    if "db" not in g:
        g.db = db.connect()
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


@app.errorhandler(ApiError)
def handle_api_error(e):
    return jsonify(error=e.message), e.status


def body():
    if request.method in ("POST", "PUT") and not request.is_json:
        raise ApiError("Ожидался JSON")
    return request.get_json(silent=True) or {}


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        uid = session.get("uid")
        if not uid:
            raise ApiError("Нужно войти", 401)
        user = get_db().execute("SELECT * FROM users WHERE id=?",
                                (uid,)).fetchone()
        if not user:
            session.clear()
            raise ApiError("Нужно войти", 401)
        g.user = user
        return fn(*args, **kwargs)
    return wrapper


def num(value, name, lo, hi, required=False):
    if value in (None, ""):
        if required:
            raise ApiError(f"Заполните поле «{name}»")
        return None
    try:
        v = float(str(value).replace(",", "."))
    except ValueError:
        raise ApiError(f"«{name}» должно быть числом")
    if not lo <= v <= hi:
        raise ApiError(f"«{name}»: допустимо от {lo} до {hi}")
    return v


def valid_date(s):
    try:
        return date.fromisoformat(s).isoformat()
    except (TypeError, ValueError):
        return date.today().isoformat()


def profile_dict(user):
    return {
        "username": user["username"],
        "height": user["height"],
        "goal": user["goal"],
        "freq": user["freq"],
        "injuries": json.loads(user["injuries"] or "[]"),
    }


# ---------- страницы ----------

PAGES = {"/": "index.html", "/progress": "progress.html",
         "/settings": "settings.html", "/login": "login.html"}


def make_page_view(filename):
    def view():
        resp = send_from_directory(STATIC_DIR, filename)
        resp.headers["Cache-Control"] = "no-cache"
        return resp
    view.__name__ = "page_" + filename.replace(".", "_")
    return view


for _url, _file in PAGES.items():
    app.add_url_rule(_url, view_func=make_page_view(_file))


@app.route("/sw.js")
def service_worker():
    resp = send_from_directory(STATIC_DIR, "sw.js")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Content-Type"] = "application/javascript; charset=utf-8"
    return resp


@app.route("/manifest.json")
def manifest():
    return send_from_directory(STATIC_DIR, "manifest.json",
                               mimetype="application/manifest+json")


# ---------- вход и регистрация ----------

@app.post("/api/register")
def register():
    data = body()
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    code = (data.get("invite") or "").strip().upper()
    if not re.fullmatch(r"[A-Za-zА-Яа-яЁё0-9_.-]{3,30}", username):
        raise ApiError("Логин: 3–30 символов, буквы, цифры, точка, _ или -")
    if len(password) < 6:
        raise ApiError("Пароль должен быть не короче 6 символов")
    conn = get_db()
    invite = conn.execute("SELECT * FROM invites WHERE code=?",
                          (code,)).fetchone()
    if not invite or invite["used_by"]:
        raise ApiError("Инвайт-код неверный или уже использован")
    if conn.execute("SELECT 1 FROM users WHERE username=?",
                    (username,)).fetchone():
        raise ApiError("Такой логин уже занят")
    cur = conn.execute(
        "INSERT INTO users (username, password_hash) VALUES (?, ?)",
        (username, generate_password_hash(password)))
    conn.execute("UPDATE invites SET used_by=?, used_at=datetime('now') "
                 "WHERE code=?", (cur.lastrowid, code))
    conn.commit()
    session.clear()
    session.permanent = True
    session["uid"] = cur.lastrowid
    return jsonify(ok=True)


@app.post("/api/login")
def login():
    data = body()
    user = get_db().execute("SELECT * FROM users WHERE username=?",
                            ((data.get("username") or "").strip(),)).fetchone()
    if not user or not check_password_hash(user["password_hash"],
                                           data.get("password") or ""):
        raise ApiError("Неверный логин или пароль", 401)
    session.clear()
    session.permanent = True
    session["uid"] = user["id"]
    return jsonify(ok=True)


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


# ---------- профиль ----------

@app.get("/api/me")
@login_required
def me():
    conn = get_db()
    has_weight = conn.execute("SELECT 1 FROM measurements WHERE user_id=?",
                              (g.user["id"],)).fetchone() is not None
    return jsonify(profile=profile_dict(g.user), has_weight=has_weight)


@app.put("/api/profile")
@login_required
def update_profile():
    data = body()
    height = num(data.get("height"), "Рост", 100, 250, required=True)
    goal = data.get("goal")
    if goal not in planner.GOALS:
        raise ApiError("Выберите цель")
    try:
        freq = int(data.get("freq"))
    except (TypeError, ValueError):
        freq = 0
    if not 2 <= freq <= 5:
        raise ApiError("Сколько раз в неделю: от 2 до 5")
    injuries = [i for i in data.get("injuries") or [] if i in planner.INJURIES]
    conn = get_db()
    conn.execute("UPDATE users SET height=?, goal=?, freq=?, injuries=? "
                 "WHERE id=?", (height, goal, freq, json.dumps(injuries),
                                g.user["id"]))
    conn.commit()
    return jsonify(ok=True)


@app.get("/api/measurements")
@login_required
def list_measurements():
    rows = get_db().execute(
        "SELECT * FROM measurements WHERE user_id=? ORDER BY date, id",
        (g.user["id"],)).fetchall()
    return jsonify(items=[dict(r) for r in rows])


@app.post("/api/measurements")
@login_required
def add_measurement():
    data = body()
    values = (
        g.user["id"],
        valid_date(data.get("date")),
        num(data.get("weight"), "Вес", 30, 300, required=True),
        num(data.get("fat_pct"), "% жира", 1, 70),
        num(data.get("muscle_kg"), "Мышечная масса", 10, 150),
        num(data.get("bmr"), "Основной обмен", 500, 5000),
    )
    conn = get_db()
    conn.execute("INSERT INTO measurements (user_id, date, weight, fat_pct, "
                 "muscle_kg, bmr) VALUES (?,?,?,?,?,?)", values)
    conn.commit()
    return jsonify(ok=True)


@app.delete("/api/measurements/<int:mid>")
@login_required
def delete_measurement(mid):
    conn = get_db()
    conn.execute("DELETE FROM measurements WHERE id=? AND user_id=?",
                 (mid, g.user["id"]))
    conn.commit()
    return jsonify(ok=True)


# ---------- каталог упражнений (общий для всех) ----------

def exercise_from_request(data):
    name = (data.get("name") or "").strip()
    if not name:
        raise ApiError("Введите название упражнения")
    if data.get("muscle") not in planner.MUSCLES:
        raise ApiError("Выберите группу мышц")
    if data.get("kind") not in ("compound", "isolation"):
        raise ApiError("Выберите тип: база или изоляция")
    if data.get("region") not in ("upper", "lower", "core"):
        raise ApiError("Выберите категорию: верх, низ или пресс/поясница")
    return {
        "name": name[:120],
        "equipment": (data.get("equipment") or "").strip()[:80],
        "muscle": data["muscle"],
        "target": (data.get("target") or "").strip()[:120],
        "helpers": (data.get("helpers") or "").strip()[:120],
        "kind": data["kind"],
        "region": data["region"],
        "stress": [s for s in data.get("stress") or []
                   if s in planner.INJURIES],
        "active": bool(data.get("active", True)),
    }


@app.get("/api/exercises")
@login_required
def list_exercises():
    exercises = db.all_exercises(get_db())
    active = [e for e in exercises if e["active"]]
    have = {e["muscle"] for e in active}
    missing = [{"muscle": m, "label": label, "hint": planner.MUSCLE_HINTS[m]}
               for m, (label, _big) in planner.MUSCLES.items()
               if m not in have]
    return jsonify(items=exercises, missing=missing,
                   muscles={k: v[0] for k, v in planner.MUSCLES.items()},
                   injuries=planner.INJURIES)


@app.post("/api/exercises")
@login_required
def create_exercise():
    conn = get_db()
    ex_id = db.save_exercise(conn, exercise_from_request(body()))
    conn.commit()
    return jsonify(ok=True, id=ex_id)


@app.put("/api/exercises/<int:ex_id>")
@login_required
def update_exercise(ex_id):
    conn = get_db()
    if not conn.execute("SELECT 1 FROM exercises WHERE id=?",
                        (ex_id,)).fetchone():
        raise ApiError("Упражнение не найдено", 404)
    db.save_exercise(conn, exercise_from_request(body()), ex_id)
    conn.commit()
    return jsonify(ok=True)


# ---------- план и дневник ----------

@app.post("/api/plan")
@login_required
def make_plan():
    data = body()
    minutes = data.get("minutes")
    kind = data.get("kind")
    if minutes not in (30, 45, 60, 90):
        raise ApiError("Выберите время: 30, 45, 60 или 90 минут")
    if kind not in planner.KINDS:
        raise ApiError("Выберите тип тренировки")
    conn = get_db()
    uid = g.user["id"]
    profile = profile_dict(g.user)
    plan = planner.build_plan(
        db.all_exercises(conn), profile, minutes, kind,
        recent_ids=db.recent_exercise_ids(conn, uid),
        history=db.last_sets(conn, uid))
    # Незавершённые старые планы больше не нужны
    conn.execute("DELETE FROM workouts WHERE user_id=? AND status='planned'",
                 (uid,))
    cur = conn.execute(
        "INSERT INTO workouts (user_id, date, kind, minutes) VALUES (?,?,?,?)",
        (uid, valid_date(data.get("date")), kind, minutes))
    conn.commit()
    plan["workout_id"] = cur.lastrowid
    plan["date"] = valid_date(data.get("date"))
    return jsonify(plan=plan)


@app.post("/api/workouts/<int:wid>/finish")
@login_required
def finish_workout(wid):
    data = body()
    conn = get_db()
    uid = g.user["id"]
    w = conn.execute("SELECT * FROM workouts WHERE id=? AND user_id=?",
                     (wid, uid)).fetchone()
    if not w:
        # План могли удалить (например, составили новый на другом
        # устройстве) — сохраняем тренировку заново, чтобы не потерять.
        cur = conn.execute(
            "INSERT INTO workouts (user_id, date, kind, minutes) "
            "VALUES (?,?,?,?)",
            (uid, valid_date(data.get("date")),
             data.get("kind") if data.get("kind") in planner.KINDS else "full",
             int(data.get("minutes") or 60)))
        wid = cur.lastrowid
    known = {r[0] for r in conn.execute("SELECT id FROM exercises")}
    rows = []
    for s in data.get("sets") or []:
        try:
            ex_id = int(s["exercise_id"])
            reps = int(s["reps"])
            weight = float(s.get("weight") or 0)
            set_no = int(s.get("set_no") or 1)
        except (KeyError, TypeError, ValueError):
            continue
        if ex_id in known and 0 < reps <= 200 and 0 <= weight <= 1000:
            rows.append((wid, ex_id, set_no, weight, reps))
    conn.execute("DELETE FROM sets WHERE workout_id=?", (wid,))
    conn.executemany("INSERT INTO sets (workout_id, exercise_id, set_no, "
                     "weight, reps) VALUES (?,?,?,?,?)", rows)
    if rows:
        conn.execute("UPDATE workouts SET status='done', "
                     "finished_at=datetime('now') WHERE id=?", (wid,))
    else:
        conn.execute("DELETE FROM workouts WHERE id=?", (wid,))
    conn.commit()
    return jsonify(ok=True, saved_sets=len(rows))


@app.get("/api/workouts")
@login_required
def history():
    conn = get_db()
    workouts = conn.execute(
        "SELECT * FROM workouts WHERE user_id=? AND status='done' "
        "ORDER BY date DESC, id DESC LIMIT 60", (g.user["id"],)).fetchall()
    out = []
    for w in workouts:
        sets = conn.execute(
            "SELECT s.*, e.name FROM sets s JOIN exercises e "
            "ON e.id = s.exercise_id WHERE s.workout_id=? ORDER BY s.id",
            (w["id"],)).fetchall()
        exercises = []
        for s in sets:
            if not exercises or exercises[-1]["exercise_id"] != s["exercise_id"]:
                exercises.append({"exercise_id": s["exercise_id"],
                                  "name": s["name"], "sets": []})
            exercises[-1]["sets"].append({"weight": s["weight"],
                                          "reps": s["reps"]})
        out.append({"id": w["id"], "date": w["date"], "kind": w["kind"],
                    "kind_label": planner.KINDS.get(w["kind"], w["kind"]),
                    "minutes": w["minutes"], "exercises": exercises})
    return jsonify(items=out)


@app.delete("/api/workouts/<int:wid>")
@login_required
def delete_workout(wid):
    conn = get_db()
    conn.execute("DELETE FROM workouts WHERE id=? AND user_id=?",
                 (wid, g.user["id"]))
    conn.commit()
    return jsonify(ok=True)


if __name__ == "__main__":
    # Локальный запуск для проверки: python app.py  →  http://127.0.0.1:5000
    os.environ.setdefault("GYM_INSECURE_COOKIE", "1")
    app.config["SESSION_COOKIE_SECURE"] = False
    app.run(debug=True)
