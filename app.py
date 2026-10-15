"""Сервер приложения «Тренер для зала» (Flask)."""
import io
import json
import os
import re
import secrets
import sqlite3
import zipfile
from datetime import date, timedelta
from functools import wraps

from flask import (Flask, g, jsonify, request, send_file, send_from_directory,
                   session)
from werkzeug.security import check_password_hash, generate_password_hash

import db
import planner

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
PHOTO_DIR = os.path.join(STATIC_DIR, "photos")
os.makedirs(PHOTO_DIR, exist_ok=True)


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
    MAX_CONTENT_LENGTH=5 * 1024 * 1024,  # не больше 5 МБ за один запрос
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


@app.errorhandler(413)
def too_large(_e):
    return jsonify(error="Файл слишком большой (максимум 5 МБ)"), 413


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
        if not user or user["blocked"]:
            session.clear()
            raise ApiError("Нужно войти", 401)
        g.user = user
        return fn(*args, **kwargs)
    return wrapper


def admin_required(fn):
    @wraps(fn)
    @login_required
    def wrapper(*args, **kwargs):
        if not g.user["is_admin"]:
            raise ApiError("Только для администратора", 403)
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
        "share": None if user["share"] is None else bool(user["share"]),
        "is_admin": bool(user["is_admin"]),
    }


# ---------- страницы ----------

PAGES = {"/": "index.html", "/progress": "progress.html",
         "/settings": "settings.html", "/login": "login.html",
         "/friends": "friends.html", "/admin": "admin.html"}


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
    if user["blocked"]:
        raise ApiError("Аккаунт заблокирован. Напишите администратору", 403)
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
    invite = conn.execute(
        "SELECT p.id, p.host_id, p.kind, p.minutes, u.username FROM pair_members m "
        "JOIN pair_sessions p ON p.id = m.pair_id JOIN users u ON u.id = p.host_id "
        "WHERE m.user_id=? AND m.status='invited' AND p.status IN ('invited', 'active') "
        "AND p.created_at >= datetime('now', '-12 hours') ORDER BY p.id DESC LIMIT 1",
        (g.user["id"],)).fetchone()
    return jsonify(profile=profile_dict(g.user), has_weight=has_weight,
                   week=week_info(conn, g.user),
                   pair_invite={"id": invite["id"], "host": invite["username"],
                                "others": [m["name"] for m in pair_members(
                                    conn, invite["id"], g.user["id"])
                                    if m["user_id"] != invite["host_id"]
                                    and m["status"] in ("invited", "active")],
                                "kind": invite["kind"], "minutes": invite["minutes"],
                                "kind_label": planner.KINDS.get(invite["kind"])}
                   if invite else None)


# Что посоветовать сегодня после прошлой тренировки (чередуем верх и низ)
NEXT_KIND = {"upper": "lower", "lower": "upper", "glutes": "upper"}


def week_info(conn, user):
    """Посещения на этой неделе, прошлая тренировка и совет на сегодня."""
    today = date.today()
    monday = (today - timedelta(days=today.weekday())).isoformat()
    visits = conn.execute(
        "SELECT COUNT(DISTINCT date) FROM workouts WHERE user_id=? "
        "AND status='done' AND date >= ?", (user["id"], monday)).fetchone()[0]
    last = conn.execute(
        "SELECT id, date, kind FROM workouts WHERE user_id=? AND status='done' "
        "ORDER BY date DESC, id DESC LIMIT 1", (user["id"],)).fetchone()
    days = {}
    for r in conn.execute(
            "SELECT date, kind FROM workouts WHERE user_id=? AND status='done' "
            "AND date >= ? ORDER BY date, id", (user["id"], monday)):
        days.setdefault(r["date"], [])
        if r["kind"] not in days[r["date"]]:
            days[r["date"]].append(r["kind"])
    vol = conn.execute(
        "SELECT COALESCE(SUM(s.weight * s.reps), 0), COUNT(s.id) "
        "FROM sets s JOIN workouts w ON w.id = s.workout_id "
        "WHERE w.user_id=? AND w.status='done' AND w.date >= ?",
        (user["id"], monday)).fetchone()
    last_info = None
    if last:
        rows = conn.execute(
            """
            SELECT e.name, MAX(s.weight) AS top, COUNT(s.id) AS sets,
                   SUM(s.weight * s.reps) AS volume,
                   (SELECT MAX(s2.weight) FROM sets s2
                    JOIN workouts w2 ON w2.id = s2.workout_id
                    WHERE w2.user_id = w.user_id AND w2.status = 'done'
                      AND s2.exercise_id = s.exercise_id
                      AND (w2.date < w.date OR (w2.date = w.date AND w2.id < w.id))
                   ) AS prev
            FROM sets s JOIN workouts w ON w.id = s.workout_id
            JOIN exercises e ON e.id = s.exercise_id
            WHERE w.id = ? GROUP BY s.exercise_id
            """, (last["id"],)).fetchall()
        last_info = {
            "date": last["date"], "kind": last["kind"],
            "kind_label": planner.KINDS.get(last["kind"], last["kind"]),
            "exercises": len(rows), "sets": sum(r["sets"] for r in rows),
            "volume": round(sum(r["volume"] for r in rows)),
            "records": [{"name": r["name"], "weight": r["top"], "prev": r["prev"]}
                        for r in rows if r["prev"] is not None and r["top"] > r["prev"]],
            "reactions": reactions_for(conn, [last["id"]], user["id"]).get(last["id"], []),
            "partner": pair_partner(conn, last["id"], user["id"]),
        }
    few = user["freq"] <= 2
    if last is None:
        suggest = "full" if few else "upper"
    elif last["kind"] == "full":
        suggest = "full" if few else "upper"
    else:
        suggest = NEXT_KIND.get(last["kind"], "full")
    return {
        "visits": visits,
        "goal": user["freq"],
        "suggest": suggest,
        "monday": monday,
        "days": [{"date": d, "kinds": k} for d, k in days.items()],
        "volume": round(vol[0]),
        "sets": vol[1],
        "last": last_info,
    }


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
    if data.get("region") not in ("upper", "lower", "core", "cardio"):
        raise ApiError("Выберите категорию: верх, низ, пресс/поясница или кардио")
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
        "active": bool(data.get("club_active", data.get("active", True))),
        "tips": "\n".join(line.strip() for line in
                          str(data.get("tips") or "").splitlines()
                          if line.strip())[:2000],
    }


@app.get("/api/exercises")
@login_required
def list_exercises():
    exercises = db.exercises_for(get_db(), g.user["id"])
    active = [e for e in exercises if e["active"]]
    have = {e["muscle"] for e in active}
    missing = [{"muscle": m, "label": label, "hint": planner.MUSCLE_HINTS[m]}
               for m, (label, _big) in planner.MUSCLES.items()
               if m not in have]
    return jsonify(items=exercises, missing=missing,
                   muscles={k: v[0] for k, v in planner.MUSCLES.items()},
                   injuries=planner.INJURIES)


@app.put("/api/exercises/<int:ex_id>/mine")
@login_required
def toggle_mine(ex_id):
    """Личный переключатель: использовать ли упражнение в моих планах."""
    conn = get_db()
    if not conn.execute("SELECT 1 FROM exercises WHERE id=?", (ex_id,)).fetchone():
        raise ApiError("Упражнение не найдено", 404)
    db.set_hidden(conn, g.user["id"], ex_id, not body().get("enabled", True))
    conn.commit()
    return jsonify(ok=True)


@app.post("/api/exercises")
@login_required
def create_exercise():
    conn = get_db()
    data = exercise_from_request(body())
    ex_id = db.save_exercise(conn, data)
    db.log_catalog(conn, g.user["username"], ex_id, data["name"], "добавил(а) упражнение")
    conn.commit()
    return jsonify(ok=True, id=ex_id)


@app.put("/api/exercises/<int:ex_id>")
@login_required
def update_exercise(ex_id):
    conn = get_db()
    old = conn.execute("SELECT * FROM exercises WHERE id=?", (ex_id,)).fetchone()
    if not old:
        raise ApiError("Упражнение не найдено", 404)
    data = exercise_from_request(body())
    db.save_exercise(conn, data, ex_id)
    changes = describe_changes(db.exercise_to_dict(old), data)
    if changes:
        db.log_catalog(conn, g.user["username"], ex_id, data["name"], changes)
    conn.commit()
    return jsonify(ok=True)


FIELD_NAMES = {"equipment": "тренажёр", "muscle": "группу мышц", "target": "целевые мышцы",
               "helpers": "вспомогательные", "kind": "тип", "region": "категорию",
               "stress": "нагрузку на зоны", "tips": "советы «Как делать»"}


def describe_changes(old, new):
    """Человеческое описание правки упражнения для журнала."""
    parts = []
    if old["name"] != new["name"]:
        parts.append(f"переименовал(а) «{old['name']}» → «{new['name']}»")
    if old["active"] != new["active"]:
        parts.append("вернул(а) в клуб" if new["active"] else "отметил(а) «нет в клубе»")
    changed = [label for f, label in FIELD_NAMES.items()
               if (old.get(f) or "") != (new.get(f) or "")]
    if changed:
        parts.append("изменил(а): " + ", ".join(changed))
    return "; ".join(parts)


def image_ext(data):
    """Определить формат картинки по первым байтам файла."""
    if data[:3] == bytes([0xFF, 0xD8, 0xFF]):
        return ".jpg"
    if data[:8] == bytes([0x89]) + b"PNG" + bytes([13, 10, 26, 10]):
        return ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


def remove_photo_file(name):
    if name:
        path = os.path.join(PHOTO_DIR, os.path.basename(name))
        if os.path.exists(path):
            os.remove(path)


@app.post("/api/exercises/<int:ex_id>/photo")
@login_required
def upload_photo(ex_id):
    conn = get_db()
    row = conn.execute("SELECT photo, name FROM exercises WHERE id=?",
                       (ex_id,)).fetchone()
    if not row:
        raise ApiError("Упражнение не найдено", 404)
    f = request.files.get("photo")
    if not f:
        raise ApiError("Фото не выбрано")
    data = f.read()
    ext = image_ext(data)
    if not ext:
        raise ApiError("Нужна картинка в формате JPG, PNG или WebP")
    name = f"ex{ex_id}_{secrets.token_hex(6)}{ext}"
    with open(os.path.join(PHOTO_DIR, name), "wb") as out:
        out.write(data)
    conn.execute("UPDATE exercises SET photo=? WHERE id=?", (name, ex_id))
    db.log_catalog(conn, g.user["username"], ex_id, row["name"],
                   "заменил(а) фото" if row["photo"] else "добавил(а) фото")
    conn.commit()
    remove_photo_file(row["photo"])
    return jsonify(ok=True, photo_url="/static/photos/" + name)


@app.delete("/api/exercises/<int:ex_id>/photo")
@login_required
def delete_photo(ex_id):
    conn = get_db()
    row = conn.execute("SELECT photo, name FROM exercises WHERE id=?",
                       (ex_id,)).fetchone()
    if not row:
        raise ApiError("Упражнение не найдено", 404)
    conn.execute("UPDATE exercises SET photo=NULL WHERE id=?", (ex_id,))
    if row["photo"]:
        db.log_catalog(conn, g.user["username"], ex_id, row["name"], "удалил(а) фото")
    conn.commit()
    remove_photo_file(row["photo"])
    return jsonify(ok=True)


# ---------- админ-панель ----------

def admin_target(conn, uid):
    u = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        raise ApiError("Пользователь не найден", 404)
    if u["id"] == g.user["id"]:
        raise ApiError("Это действие нельзя применить к себе")
    return u


def folder_size(path):
    total = count = 0
    for name in os.listdir(path):
        full = os.path.join(path, name)
        if os.path.isfile(full):
            total += os.path.getsize(full)
            count += 1
    return total, count


@app.get("/api/admin/overview")
@admin_required
def admin_overview():
    conn = get_db()
    users = conn.execute(
        """
        SELECT u.id, u.username, u.created_at, u.is_admin, u.blocked, u.share,
          (SELECT COUNT(*) FROM workouts w WHERE w.user_id=u.id AND w.status='done') AS workouts,
          (SELECT MAX(date) FROM workouts w WHERE w.user_id=u.id AND w.status='done') AS last_date,
          (SELECT code FROM invites i WHERE i.used_by=u.id) AS invite
        FROM users u ORDER BY u.id
        """).fetchall()
    invites = conn.execute(
        "SELECT i.code, i.created_at, i.used_at, u.username FROM invites i "
        "LEFT JOIN users u ON u.id = i.used_by ORDER BY i.used_by IS NOT NULL, i.created_at DESC"
    ).fetchall()
    photos_size, photos_count = folder_size(PHOTO_DIR)
    week_ago = (date.today() - timedelta(days=7)).isoformat()
    one = lambda sql, *a: conn.execute(sql, a).fetchone()[0]  # noqa: E731
    return jsonify(
        me=g.user["id"],
        users=[dict(u) for u in users],
        invites=[dict(i) for i in invites],
        system={
            "users": len(users),
            "workouts": one("SELECT COUNT(*) FROM workouts WHERE status='done'"),
            "workouts_week": one("SELECT COUNT(*) FROM workouts WHERE status='done' AND date >= ?",
                                 week_ago),
            "sets": one("SELECT COUNT(*) FROM sets"),
            "exercises": one("SELECT COUNT(*) FROM exercises"),
            "db_size": os.path.getsize(db.DB_PATH) if os.path.exists(db.DB_PATH) else 0,
            "photos_size": photos_size,
            "photos": photos_count,
        })


@app.post("/api/admin/invites")
@admin_required
def admin_create_invites():
    try:
        count = max(1, min(20, int(body().get("count") or 1)))
    except (TypeError, ValueError):
        count = 1
    conn = get_db()
    codes = []
    for _ in range(count):
        code = db.new_invite_code()
        conn.execute("INSERT INTO invites (code) VALUES (?)", (code,))
        codes.append(code)
    conn.commit()
    return jsonify(codes=codes)


@app.delete("/api/admin/invites/<code>")
@admin_required
def admin_delete_invite(code):
    conn = get_db()
    cur = conn.execute("DELETE FROM invites WHERE code=? AND used_by IS NULL", (code,))
    conn.commit()
    if not cur.rowcount:
        raise ApiError("Код не найден или уже использован", 404)
    return jsonify(ok=True)


@app.post("/api/admin/users/<int:uid>/password")
@admin_required
def admin_reset_password(uid):
    conn = get_db()
    admin_target(conn, uid)
    # Временный пароль без похожих символов — его продиктуют/перешлют другу
    password = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz23456789") for _ in range(8))
    conn.execute("UPDATE users SET password_hash=? WHERE id=?",
                 (generate_password_hash(password), uid))
    conn.commit()
    return jsonify(password=password)


@app.post("/api/admin/users/<int:uid>/block")
@admin_required
def admin_block(uid):
    conn = get_db()
    admin_target(conn, uid)
    blocked = bool(body().get("blocked"))
    conn.execute("UPDATE users SET blocked=? WHERE id=?", (1 if blocked else 0, uid))
    conn.commit()
    return jsonify(ok=True, blocked=blocked)


@app.post("/api/admin/users/<int:uid>/admin")
@admin_required
def admin_set_admin(uid):
    conn = get_db()
    admin_target(conn, uid)
    is_admin = bool(body().get("admin"))
    conn.execute("UPDATE users SET is_admin=? WHERE id=?", (1 if is_admin else 0, uid))
    conn.commit()
    return jsonify(ok=True, admin=is_admin)


@app.post("/api/admin/users/<int:uid>/delete")
@admin_required
def admin_delete_user(uid):
    conn = get_db()
    u = admin_target(conn, uid)
    if (body().get("confirm") or "").strip() != u["username"]:
        raise ApiError("Для подтверждения введите логин пользователя точно")
    db.delete_user(conn, uid)
    conn.commit()
    return jsonify(ok=True)


@app.get("/api/admin/log")
@admin_required
def admin_log():
    rows = get_db().execute("SELECT * FROM catalog_log ORDER BY id DESC LIMIT 200").fetchall()
    return jsonify(items=[dict(r) for r in rows])


@app.get("/api/admin/backup")
@admin_required
def admin_backup():
    """Скачать копию базы (безопасно даже во время работы сайта)."""
    tmp = os.path.join(BASE_DIR, f".backup-{secrets.token_hex(4)}.db")
    try:
        dst = sqlite3.connect(tmp)
        get_db().backup(dst)
        dst.close()
        with open(tmp, "rb") as f:
            data = io.BytesIO(f.read())
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return send_file(data, mimetype="application/octet-stream", as_attachment=True,
                     download_name=f"gym-backup-{date.today().isoformat()}.db")


@app.get("/api/admin/photos.zip")
@admin_required
def admin_photos():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for name in sorted(os.listdir(PHOTO_DIR)):
            full = os.path.join(PHOTO_DIR, name)
            if os.path.isfile(full):
                z.write(full, name)
    buf.seek(0)
    return send_file(buf, mimetype="application/zip", as_attachment=True,
                     download_name=f"gym-photos-{date.today().isoformat()}.zip")


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
        db.exercises_for(conn, uid), profile, minutes, kind,
        recent_ids=db.recent_exercise_ids(conn, uid),
        history=db.exercise_history(conn, uid),
        notes=db.user_notes(conn, uid))
    plan["workout_id"] = start_workout(conn, uid, data.get("date"), kind, minutes)
    plan["date"] = valid_date(data.get("date"))
    return jsonify(plan=plan)


def start_workout(conn, uid, day, kind, minutes, pair_id=None):
    # Незавершённые старые планы больше не нужны
    conn.execute("DELETE FROM workouts WHERE user_id=? AND status='planned'", (uid,))
    cur = conn.execute(
        "INSERT INTO workouts (user_id, date, kind, minutes, pair_id) VALUES (?,?,?,?,?)",
        (uid, valid_date(day), kind, minutes, pair_id))
    conn.commit()
    return cur.lastrowid


# ---------- совместная тренировка (2–3 человека) ----------

MAX_PARTNERS = 2   # кроме того, кто зовёт


@app.get("/api/users")
@login_required
def list_users():
    rows = get_db().execute("SELECT username FROM users WHERE id != ? AND blocked = 0 "
                            "ORDER BY username", (g.user["id"],)).fetchall()
    return jsonify(items=[r["username"] for r in rows])


def pair_members(conn, pid, uid=None):
    """Участники совместной тренировки, кроме uid."""
    rows = conn.execute(
        "SELECT m.user_id, m.status, m.progress, u.username FROM pair_members m "
        "JOIN users u ON u.id = m.user_id WHERE m.pair_id=? ORDER BY m.rowid",
        (pid,)).fetchall()
    return [{"user_id": r["user_id"], "name": r["username"], "status": r["status"],
             "progress": json.loads(r["progress"]) if r["progress"] else None}
            for r in rows if r["user_id"] != uid]


def names_text(names):
    """«Рита» / «Рита и Паша»."""
    if len(names) <= 1:
        return names[0] if names else ""
    return ", ".join(names[:-1]) + " и " + names[-1]


def pair_info(conn, pid, uid, role):
    others = [m["name"] for m in pair_members(conn, pid, uid) if m["status"] != "declined"]
    return {"id": pid, "role": role, "partners": others, "partner": names_text(others)}


@app.post("/api/pair")
@login_required
def create_pair():
    """Позвать 1–2 друзей: общий план из упражнений, подходящих всем."""
    data = body()
    minutes = data.get("minutes")
    kind = data.get("kind")
    if minutes not in (30, 45, 60, 90) or kind not in planner.KINDS:
        raise ApiError("Выберите время и тип тренировки")
    conn = get_db()
    me_row = g.user
    names = data.get("partners")
    if not isinstance(names, list):
        names = [data.get("partner")]
    names = list(dict.fromkeys(str(n).strip() for n in names if n))
    if not names:
        raise ApiError("Выберите, с кем идёте")
    if len(names) > MAX_PARTNERS:
        raise ApiError(f"Можно позвать не больше {MAX_PARTNERS} друзей")
    partners = []
    for name in names:
        row = conn.execute("SELECT * FROM users WHERE username=? AND id != ? AND blocked = 0",
                           (name, me_row["id"])).fetchone()
        if not row:
            raise ApiError(f"Не нашли друга «{name}»")
        partners.append(row)
    mine = db.exercises_for(conn, me_row["id"])
    active = {e["id"]: e["active"] for e in mine}
    injuries = set(profile_dict(me_row)["injuries"])
    for partner in partners:
        for e in db.exercises_for(conn, partner["id"]):
            active[e["id"]] = active.get(e["id"], False) and e["active"]
        injuries |= set(profile_dict(partner)["injuries"])
    everyone = [dict(e, active=active[e["id"]]) for e in mine]
    profile = profile_dict(me_row)
    common = dict(profile, injuries=sorted(injuries))
    plan = planner.build_plan(
        everyone, common, minutes, kind,
        recent_ids=db.recent_exercise_ids(conn, me_row["id"]),
        history=db.exercise_history(conn, me_row["id"]),
        notes=db.user_notes(conn, me_row["id"]))
    # Подходы/повторы — по моей цели, а «ограничения» в карточках — только мои
    plan = planner.plan_from_ids(
        mine, profile, minutes, kind, [i["exercise_id"] for i in plan["items"]],
        history=db.exercise_history(conn, me_row["id"]), notes=db.user_notes(conn, me_row["id"]))
    conn.execute("UPDATE pair_sessions SET status='cancelled' WHERE host_id=? "
                 "AND status='invited'", (me_row["id"],))
    cur = conn.execute(
        "INSERT INTO pair_sessions (host_id, guest_id, kind, minutes, date, ex_ids) "
        "VALUES (?,?,?,?,?,?)",
        (me_row["id"], partners[0]["id"], kind, minutes, valid_date(data.get("date")),
         json.dumps([i["exercise_id"] for i in plan["items"]])))
    pair_id = cur.lastrowid
    conn.execute("INSERT INTO pair_members (pair_id, user_id, status) VALUES (?,?,'active')",
                 (pair_id, me_row["id"]))
    conn.executemany("INSERT INTO pair_members (pair_id, user_id) VALUES (?,?)",
                     [(pair_id, p["id"]) for p in partners])
    plan["workout_id"] = start_workout(conn, me_row["id"], data.get("date"), kind,
                                       minutes, pair_id)
    plan["date"] = valid_date(data.get("date"))
    plan["pair"] = pair_info(conn, pair_id, me_row["id"], "host")
    return jsonify(plan=plan)


def pair_session(conn, pid):
    """Совместная тренировка и моя запись в ней (чужим — 404)."""
    p = conn.execute("SELECT * FROM pair_sessions WHERE id=?", (pid,)).fetchone()
    member = conn.execute("SELECT * FROM pair_members WHERE pair_id=? AND user_id=?",
                          (pid, g.user["id"])).fetchone()
    if not p or not member:
        raise ApiError("Приглашение не найдено", 404)
    return p, member


@app.post("/api/pair/<int:pid>/join")
@login_required
def join_pair(pid):
    data = body()
    conn = get_db()
    p, member = pair_session(conn, pid)
    if (p["host_id"] == g.user["id"] or member["status"] not in ("invited", "active")
            or p["status"] not in ("invited", "active")):
        raise ApiError("Это приглашение уже неактуально")
    uid = g.user["id"]
    plan = planner.plan_from_ids(
        db.exercises_for(conn, uid), profile_dict(g.user), p["minutes"], p["kind"],
        json.loads(p["ex_ids"]), history=db.exercise_history(conn, uid),
        notes=db.user_notes(conn, uid))
    conn.execute("UPDATE pair_members SET status='active' WHERE pair_id=? AND user_id=?",
                 (pid, uid))
    conn.execute("UPDATE pair_sessions SET status='active' WHERE id=?", (pid,))
    plan["workout_id"] = start_workout(conn, uid, data.get("date"), p["kind"],
                                       p["minutes"], pid)
    plan["date"] = valid_date(data.get("date"))
    plan["pair"] = pair_info(conn, pid, uid, "guest")
    return jsonify(plan=plan)


@app.post("/api/pair/<int:pid>/decline")
@login_required
def decline_pair(pid):
    conn = get_db()
    p, member = pair_session(conn, pid)
    if member["status"] == "invited":
        conn.execute("UPDATE pair_members SET status='declined' WHERE pair_id=? AND user_id=?",
                     (pid, g.user["id"]))
        waiting = conn.execute(
            "SELECT 1 FROM pair_members WHERE pair_id=? AND user_id != ? "
            "AND status IN ('invited', 'active')", (pid, p["host_id"])).fetchone()
        if p["status"] == "invited" and not waiting:
            conn.execute("UPDATE pair_sessions SET status='declined' WHERE id=?", (pid,))
        conn.commit()
    return jsonify(ok=True)


def small_int(v):
    try:
        return max(0, min(999, int(v)))
    except (TypeError, ValueError):
        return 0


@app.put("/api/pair/<int:pid>/progress")
@login_required
def pair_progress(pid):
    """Отправить свой прогресс и получить прогресс остальных."""
    data = body()
    conn = get_db()
    p, _ = pair_session(conn, pid)
    mine = {k: small_int(data.get(k)) for k in ("cur", "count", "done", "total")}
    mine["name"] = str(data.get("name") or "")[:120]
    conn.execute("UPDATE pair_members SET progress=? WHERE pair_id=? AND user_id=?",
                 (json.dumps(mine, ensure_ascii=False), pid, g.user["id"]))
    conn.commit()
    others = [{k: m[k] for k in ("name", "status", "progress")}
              for m in pair_members(conn, pid, g.user["id"])]
    first = next((m["progress"] for m in others if m["progress"]), None)
    return jsonify(status=p["status"], partners=others, partner=first)


def pair_partner(conn, wid, uid):
    """С кем была совместная тренировка («Рита» или «Рита и Паша») или None."""
    w = conn.execute("SELECT user_id, pair_id FROM workouts WHERE id=?", (wid,)).fetchone()
    if not w or not w["pair_id"]:
        return None
    names = [m["name"] for m in pair_members(conn, w["pair_id"], w["user_id"])
             if m["status"] == "active"]
    return names_text(names) or None


# ---------- реакции ----------

REACTIONS = ["💪", "🔥", "👏", "🍑"]


def reactions_for(conn, wids, uid):
    """{workout_id: [{emoji, count, mine, names}]}"""
    if not wids:
        return {}
    marks = ",".join("?" * len(wids))
    out = {}
    for r in conn.execute(
            f"SELECT r.workout_id, r.emoji, r.user_id, u.username FROM reactions r "
            f"JOIN users u ON u.id = r.user_id WHERE r.workout_id IN ({marks})", wids):
        lst = out.setdefault(r["workout_id"], {})
        e = lst.setdefault(r["emoji"], {"emoji": r["emoji"], "count": 0,
                                        "mine": False, "names": []})
        e["count"] += 1
        e["mine"] = e["mine"] or r["user_id"] == uid
        e["names"].append(r["username"])
    return {w: sorted(v.values(), key=lambda x: REACTIONS.index(x["emoji"])
                      if x["emoji"] in REACTIONS else 99)
            for w, v in out.items()}


@app.post("/api/workouts/<int:wid>/react")
@login_required
def react(wid):
    emoji = body().get("emoji")
    if emoji not in REACTIONS:
        raise ApiError("Такой реакции нет")
    conn = get_db()
    uid = g.user["id"]
    w = conn.execute("SELECT w.user_id, u.share FROM workouts w JOIN users u "
                     "ON u.id = w.user_id WHERE w.id=? AND w.status='done'",
                     (wid,)).fetchone()
    if not w or (w["user_id"] != uid and w["share"] != 1):
        raise ApiError("Тренировка не найдена", 404)
    if conn.execute("SELECT 1 FROM reactions WHERE workout_id=? AND user_id=? AND emoji=?",
                    (wid, uid, emoji)).fetchone():
        conn.execute("DELETE FROM reactions WHERE workout_id=? AND user_id=? AND emoji=?",
                     (wid, uid, emoji))
    else:
        conn.execute("INSERT INTO reactions (workout_id, user_id, emoji) VALUES (?,?,?)",
                     (wid, uid, emoji))
    conn.commit()
    return jsonify(reactions=reactions_for(conn, [wid], uid).get(wid, []))


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
        pair_id = data.get("pair_id")
        if pair_id and not conn.execute(
                "SELECT 1 FROM pair_members WHERE pair_id=? AND user_id=?",
                (pair_id, uid)).fetchone():
            pair_id = None
        cur = conn.execute(
            "INSERT INTO workouts (user_id, date, kind, minutes, pair_id) "
            "VALUES (?,?,?,?,?)",
            (uid, valid_date(data.get("date")),
             data.get("kind") if data.get("kind") in planner.KINDS else "full",
             int(data.get("minutes") or 60), pair_id))
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
    notes = {}
    for ex_id, note in (data.get("notes") or {}).items():
        try:
            ex_id = int(ex_id)
        except ValueError:
            continue
        if ex_id in known and isinstance(note, str):
            notes[ex_id] = note
    db.save_notes(conn, uid, notes)
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


@app.get("/api/stats")
@login_required
def stats():
    """Данные для графиков и посещаемости."""
    conn = get_db()
    uid = g.user["id"]
    workouts = conn.execute(
        """
        SELECT w.id, w.date, w.kind, COUNT(s.id) AS sets,
               COALESCE(SUM(s.weight * s.reps), 0) AS volume
        FROM workouts w LEFT JOIN sets s ON s.workout_id = w.id
        WHERE w.user_id = ? AND w.status = 'done'
        GROUP BY w.id ORDER BY w.date, w.id
        """, (uid,)).fetchall()

    # Лучший подход в каждой тренировке по каждому упражнению
    rows = conn.execute(
        """
        SELECT s.exercise_id, e.name, e.muscle, w.date, s.weight, s.reps
        FROM sets s JOIN workouts w ON w.id = s.workout_id
        JOIN exercises e ON e.id = s.exercise_id
        WHERE w.user_id = ? AND w.status = 'done'
        ORDER BY w.date, w.id
        """, (uid,)).fetchall()
    by_ex = {}
    for r in rows:
        ex = by_ex.setdefault(r["exercise_id"], {
            "id": r["exercise_id"], "name": r["name"], "muscle": r["muscle"],
            "points": {}})
        # Оценка максимума на 1 повтор (формула Эпли) — для сравнения подходов
        e1rm = r["weight"] * (1 + r["reps"] / 30)
        best = ex["points"].get(r["date"])
        if best is None or e1rm > best["e1rm"]:
            ex["points"][r["date"]] = {"date": r["date"], "weight": r["weight"],
                                       "reps": r["reps"], "e1rm": round(e1rm, 1)}
    exercises = sorted(
        ({**ex, "points": list(ex["points"].values())} for ex in by_ex.values()),
        key=lambda ex: -len(ex["points"]))

    monday = date.today() - timedelta(days=date.today().weekday())
    weeks = [(monday - timedelta(weeks=i)).isoformat() for i in range(MUSCLE_WEEKS - 1, -1, -1)]
    muscles = conn.execute(
        """
        SELECT e.muscle, w.date
        FROM sets s JOIN workouts w ON w.id = s.workout_id
        JOIN exercises e ON e.id = s.exercise_id
        WHERE w.user_id = ? AND w.status = 'done' AND w.date >= ?
        """, (uid, weeks[0])).fetchall()

    return jsonify(
        freq=g.user["freq"],
        workouts=[{"date": w["date"], "kind": w["kind"],
                   "kind_label": planner.KINDS.get(w["kind"], w["kind"]),
                   "sets": w["sets"], "volume": round(w["volume"])}
                  for w in workouts],
        exercises=exercises,
        muscle_weeks={"weeks": weeks,
                      "rows": muscle_week_rows(muscles, weeks, g.user["goal"])},
    )


MUSCLE_WEEKS = 4
# Сколько рабочих подходов в неделю нужно группе мышц: (от, до).
# Большим группам — больше, мелким (бицепс, дельты, икры, пресс) — меньше.
WEEKLY_SETS = {
    "hypertrophy": {True: (10, 20), False: (6, 14)},
    "strength": {True: (8, 16), False: (4, 10)},
    "maintain": {True: (6, 12), False: (3, 8)},
}


def muscle_week_rows(rows, weeks, goal):
    """Подходы на каждую группу мышц (кроме кардио) по неделям + норма.
    Считаем только основную мышцу упражнения."""
    counts = {}
    for r in rows:
        day = date.fromisoformat(r["date"])
        week = (day - timedelta(days=day.weekday())).isoformat()
        if week in weeks:
            per = counts.setdefault(r["muscle"], [0] * len(weeks))
            per[weeks.index(week)] += 1
    norms = WEEKLY_SETS.get(goal, WEEKLY_SETS["hypertrophy"])
    return [{"muscle": m, "label": label, "lo": norms[big][0], "hi": norms[big][1],
             "sets": counts.get(m, [0] * len(weeks))}
            for m, (label, big) in planner.MUSCLES.items() if m != "cardio"]


MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль",
          "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]


def prev_month(month):
    y, m = map(int, month.split("-"))
    return f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"


@app.get("/api/summary")
@login_required
def month_summary():
    """Итоги месяца для карточки «поделиться»."""
    month = request.args.get("month") or date.today().isoformat()[:7]
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
        raise ApiError("Неверный месяц")
    conn = get_db()
    uid = g.user["id"]
    rows = conn.execute(
        """
        SELECT w.id AS wid, w.date, w.kind, s.exercise_id, e.name, s.weight, s.reps
        FROM workouts w JOIN sets s ON s.workout_id = w.id
        JOIN exercises e ON e.id = s.exercise_id
        WHERE w.user_id = ? AND w.status = 'done'
        ORDER BY w.date, w.id, s.id
        """, (uid,)).fetchall()
    all_days = {r["date"] for r in rows}

    def empty():
        return {"days": set(), "workouts": set(), "sets": 0, "volume": 0.0, "kinds": {}}
    cur, prev = empty(), empty()
    best = {}          # лучший вес в упражнении до текущей тренировки
    records = {}       # exercise_id -> рекорд этого месяца (лучший из них)
    workout_top = {}
    for r in rows:
        m = r["date"][:7]
        agg = cur if m == month else prev if m == prev_month(month) else None
        if agg is not None:
            agg["days"].add(r["date"])
            if r["wid"] not in agg["workouts"]:
                agg["workouts"].add(r["wid"])
                agg["kinds"][r["kind"]] = agg["kinds"].get(r["kind"], 0) + 1
            agg["sets"] += 1
            agg["volume"] += r["weight"] * r["reps"]
        key = (r["wid"], r["exercise_id"])
        workout_top[key] = max(workout_top.get(key, 0), r["weight"])
    # Рекорды — как в «Компании»: лучший вес в тренировке выше всех прошлых
    for (wid, ex_id), top in workout_top.items():   # порядок вставки = по датам
        prev_best = best.get(ex_id)
        if prev_best is not None and top > prev_best and wid in cur["workouts"]:
            rec = records.get(ex_id)
            start = rec["from"] if rec else prev_best
            records[ex_id] = {"from": start, "to": top}
        if prev_best is None or top > prev_best:
            best[ex_id] = top
    names = {r["exercise_id"]: r["name"] for r in rows}
    recs = sorted(({"name": names[ex], "from": v["from"], "to": v["to"]}
                   for ex, v in records.items()),
                  key=lambda x: -(x["to"] - x["from"]) / (x["from"] or 1))
    favorite = max(cur["kinds"], key=cur["kinds"].get) if cur["kinds"] else None
    # Недели, начавшиеся в этом месяце, где выполнена цель по посещениям
    y, mnum = map(int, month.split("-"))
    first = date(y, mnum, 1)
    monday = first + timedelta(days=(7 - first.weekday()) % 7)
    weeks_goal = 0
    while monday.month == mnum:
        week = {(monday + timedelta(days=i)).isoformat() for i in range(7)}
        weeks_goal += len(week & all_days) >= g.user["freq"]
        monday += timedelta(days=7)
    return jsonify(
        month=month, title=f"{MONTHS[mnum - 1]} {y}", username=g.user["username"],
        visits=len(cur["days"]), workouts=len(cur["workouts"]), sets=cur["sets"],
        volume=round(cur["volume"]), records=recs, records_count=len(recs),
        favorite=planner.KINDS.get(favorite) if favorite else None,
        weeks_goal=weeks_goal, freq=g.user["freq"],
        prev={"visits": len(prev["days"]), "volume": round(prev["volume"])},
    )


ACHIEVEMENTS = [
    # (значок, название, описание, что считаем, сколько нужно)
    ("🏁", "Первый шаг", "Первая тренировка", "workouts", 1),
    ("💪", "Втянулся", "10 тренировок", "workouts", 10),
    ("🔥", "Завсегдатай", "25 тренировок", "workouts", 25),
    ("🏆", "Полсотни", "50 тренировок", "workouts", 50),
    ("💯", "Сотка", "100 тренировок", "workouts", 100),
    ("📅", "Режим", "2 недели подряд с выполненной целью", "streak", 2),
    ("🗓", "Месяц без пропусков", "4 недели подряд с целью", "streak", 4),
    ("⚙️", "Машина", "8 недель подряд с целью", "streak", 8),
    ("⭐", "Первый рекорд", "Побить свой лучший вес", "records", 1),
    ("🌟", "Рекордсмен", "10 личных рекордов", "records", 10),
    ("🏋️", "10 тонн", "Поднять в сумме 10 000 кг", "volume", 10000),
    ("🚛", "50 тонн", "Поднять в сумме 50 000 кг", "volume", 50000),
    ("🍑", "Железная попа", "10 тренировок «Жопа»", "glutes", 10),
]


def best_week_streak(dates, goal):
    """Самая длинная серия недель подряд, где посещений не меньше цели."""
    weeks = {}
    for d in set(dates):
        day = date.fromisoformat(d)
        monday = day - timedelta(days=day.weekday())
        weeks[monday] = weeks.get(monday, 0) + 1
    good = sorted(m for m, n in weeks.items() if n >= goal)
    best = run = 0
    prev = None
    for m in good:
        run = run + 1 if prev and (m - prev).days == 7 else 1
        best = max(best, run)
        prev = m
    return best


@app.get("/api/friends")
@login_required
def friends():
    conn = get_db()
    uid = g.user["id"]
    users = {r["id"]: r for r in conn.execute(
        "SELECT id, username, share FROM users")}
    sharing = {i for i, u in users.items() if u["share"] == 1}
    rows = conn.execute(
        """
        SELECT w.id AS wid, w.user_id, w.date, w.kind,
               s.exercise_id, e.name, s.weight, s.reps
        FROM workouts w JOIN sets s ON s.workout_id = w.id
        JOIN exercises e ON e.id = s.exercise_id
        WHERE w.status = 'done' AND (w.user_id = ? OR w.user_id IN (
            SELECT id FROM users WHERE share = 1))
        ORDER BY w.date, w.id, s.id
        """, (uid,)).fetchall()

    workouts = {}
    for r in rows:
        w = workouts.setdefault(r["wid"], {
            "user_id": r["user_id"], "date": r["date"], "kind": r["kind"],
            "sets": 0, "volume": 0.0, "max": {}})
        w["sets"] += 1
        w["volume"] += r["weight"] * r["reps"]
        key = (r["exercise_id"], r["name"])
        w["max"][key] = max(w["max"].get(key, 0), r["weight"])

    # Рекорды: лучший вес в упражнении выше, чем во всех прошлых тренировках
    best = {}
    for w in workouts.values():          # уже по порядку дат
        w["records"] = []
        for (ex_id, name), top in w["max"].items():
            key = (w["user_id"], ex_id)
            prev = best.get(key)
            if prev is not None and top > prev["weight"]:
                w["records"].append({"name": name, "weight": top,
                                     "prev": prev["weight"]})
            if prev is None or top > prev["weight"]:
                best[key] = {"name": name, "weight": top, "date": w["date"]}

    def summary(wid, w):
        return {"id": wid, "username": users[w["user_id"]]["username"],
                "me": w["user_id"] == uid, "date": w["date"],
                "kind_label": planner.KINDS.get(w["kind"], w["kind"]),
                "exercises": len(w["max"]), "sets": w["sets"],
                "volume": round(w["volume"]), "records": w["records"]}

    feed = [summary(wid, w) for wid, w in reversed(workouts.items())
            if w["user_id"] in sharing][:40]
    reacts = reactions_for(conn, [f["id"] for f in feed], uid)
    for f in feed:
        f["reactions"] = reacts.get(f["id"], [])
        f["partner"] = pair_partner(conn, f["id"], uid)

    month = date.today().isoformat()[:7]
    board = []
    for u in sorted(sharing):
        mine = [w for w in workouts.values()
                if w["user_id"] == u and w["date"].startswith(month)]
        board.append({"username": users[u]["username"], "me": u == uid,
                      "visits": len({w["date"] for w in mine}),
                      "workouts": len(mine),
                      "volume": round(sum(w["volume"] for w in mine))})
    board.sort(key=lambda b: (-b["visits"], -b["volume"]))

    mine = [w for w in workouts.values() if w["user_id"] == uid]
    values = {
        "workouts": len(mine),
        "streak": best_week_streak([w["date"] for w in mine], g.user["freq"]),
        "records": sum(len(w["records"]) for w in mine),
        "volume": round(sum(w["volume"] for w in mine)),
        "glutes": sum(1 for w in mine if w["kind"] == "glutes"),
    }
    achievements = [{"icon": icon, "title": title, "desc": desc,
                     "value": min(values[what], need), "need": need,
                     "done": values[what] >= need}
                    for icon, title, desc, what, need in ACHIEVEMENTS]
    records = sorted((b for (u, _ex), b in best.items() if u == uid),
                     key=lambda b: b["name"])

    return jsonify(share=profile_dict(g.user)["share"], feed=feed, emojis=REACTIONS,
                   board=board, month=month, achievements=achievements,
                   records=records)


@app.put("/api/friends/share")
@login_required
def set_share():
    share = bool(body().get("share"))
    conn = get_db()
    conn.execute("UPDATE users SET share=? WHERE id=?",
                 (1 if share else 0, g.user["id"]))
    conn.commit()
    return jsonify(ok=True, share=share)


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
