"""Тесты сервера: заметки, советы, «Компания». Запуск: python -m unittest -v"""
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
_tmp = tempfile.mkdtemp()
os.environ["GYM_DB"] = os.path.join(_tmp, "test.db")
os.environ["GYM_INSECURE_COOKIE"] = "1"

import app as gym_app  # noqa: E402
import db  # noqa: E402


def new_client(username):
    conn = db.connect()
    code = f"CODE-{username.upper()}"
    conn.execute("INSERT OR IGNORE INTO invites (code) VALUES (?)", (code,))
    conn.commit()
    conn.close()
    c = gym_app.app.test_client()
    r = c.post("/api/register", json={"username": username,
                                      "password": "secret123", "invite": code})
    assert r.status_code == 200, r.get_json()
    return c


def ex_id(name):
    conn = db.connect()
    row = conn.execute("SELECT id FROM exercises WHERE name=?", (name,)).fetchone()
    conn.close()
    return row[0]


def finish(c, day, sets, notes=None, kind="upper"):
    plan = c.post("/api/plan", json={"minutes": 45, "kind": kind,
                                     "date": day}).get_json()["plan"]
    r = c.post(f"/api/workouts/{plan['workout_id']}/finish",
               json={"date": day, "kind": kind, "minutes": 45,
                     "sets": sets, "notes": notes or {}})
    assert r.status_code == 200
    return plan


class AppTests(unittest.TestCase):

    def test_tips_and_notes_in_plan(self):
        c = new_client("anna")
        press = ex_id("Жим от груди")
        plan = finish(c, "2026-10-01",
                      [{"exercise_id": press, "set_no": 1, "weight": 40, "reps": 10}],
                      notes={str(press): "сиденье на 4"})
        self.assertTrue(all(i["tips"] for i in plan["items"]))
        self.assertTrue(plan["pool"])
        self.assertFalse(any(i["muscle"] == "cardio" for i in plan["pool"]))
        plan2 = c.post("/api/plan", json={"minutes": 90, "kind": "upper",
                                          "date": "2026-10-03"}).get_json()["plan"]
        every = plan2["pool"] + plan2["items"]
        note = next(i["note"] for i in every if i["exercise_id"] == press)
        self.assertEqual(note, "сиденье на 4")
        # пустая заметка удаляет
        finish(c, "2026-10-05", [{"exercise_id": press, "set_no": 1, "weight": 40,
                                  "reps": 10}], notes={str(press): ""})
        conn = db.connect()
        uid = conn.execute("SELECT id FROM users WHERE username='anna'").fetchone()[0]
        self.assertEqual(db.user_notes(conn, uid), {})
        conn.close()

    def test_friends_feed_records_and_privacy(self):
        boris = new_client("boris")
        vera = new_client("vera")
        bridge = ex_id("Ягодичный мост")
        finish(boris, "2026-09-01", [{"exercise_id": bridge, "set_no": 1,
                                      "weight": 50, "reps": 10}], kind="glutes")
        finish(boris, "2026-09-03", [{"exercise_id": bridge, "set_no": 1,
                                      "weight": 60, "reps": 8}], kind="glutes")

        # Борис ещё не дал согласие — Вера его не видит
        data = vera.get("/api/friends").get_json()
        self.assertIsNone(data["share"])
        self.assertFalse(any(w["username"] == "boris" for w in data["feed"]))

        boris.put("/api/friends/share", json={"share": True})
        data = vera.get("/api/friends").get_json()
        mine = [w for w in data["feed"] if w["username"] == "boris"]
        self.assertEqual(len(mine), 2)
        self.assertEqual(mine[0]["records"][0]["weight"], 60)   # новее — первым
        self.assertEqual(mine[1]["records"], [])                 # первый раз — не рекорд

        own = boris.get("/api/friends").get_json()
        self.assertEqual(own["records"][0]["weight"], 60)
        first = next(a for a in own["achievements"] if a["title"] == "Первый рекорд")
        self.assertTrue(first["done"])

        boris.put("/api/friends/share", json={"share": False})
        data = vera.get("/api/friends").get_json()
        self.assertFalse(any(w["username"] == "boris" for w in data["feed"]))
        self.assertFalse(any(b["username"] == "boris" for b in data["board"]))

    def test_exercise_tips_editable(self):
        c = new_client("gleb")
        eid = ex_id("Молот с гантелями")
        items = c.get("/api/exercises").get_json()["items"]
        ex = next(e for e in items if e["id"] == eid)
        self.assertIn("Ладони", ex["tips"])
        ex["tips"] = "  Первый  \n\n Второй "
        self.assertEqual(c.put(f"/api/exercises/{eid}", json=ex).status_code, 200)
        items = c.get("/api/exercises").get_json()["items"]
        self.assertEqual(next(e for e in items if e["id"] == eid)["tips"],
                         "Первый\nВторой")

    def test_personal_toggle_affects_only_me(self):
        dan = new_client("dan")
        eva = new_client("eva")
        hidden = {ex_id("Вертикальная тяга тросовая"), ex_id("Кроссовер: вертикальная тяга")}
        for eid in hidden:
            self.assertEqual(dan.put(f"/api/exercises/{eid}/mine",
                                     json={"enabled": False}).status_code, 200)

        def plan_ids(c):
            p = c.post("/api/plan", json={"minutes": 90, "kind": "upper"}).get_json()["plan"]
            return ({i["exercise_id"] for i in p["items"]},
                    {i["exercise_id"] for i in p["pool"]}, p["gaps"])

        items, pool, gaps = plan_ids(dan)
        self.assertFalse(hidden & (items | pool))
        self.assertIn("back_lats", {g["muscle"] for g in gaps})
        items, pool, _ = plan_ids(eva)
        self.assertTrue(hidden & items)

        cat = {e["id"]: e for e in dan.get("/api/exercises").get_json()["items"]}
        for eid in hidden:
            self.assertFalse(cat[eid]["mine"])
            self.assertTrue(cat[eid]["club_active"])

        # Правка в редакторе не сбрасывает «есть в клубе» из-за личного выключения
        eid = next(iter(hidden))
        self.assertEqual(dan.put(f"/api/exercises/{eid}", json=cat[eid]).status_code, 200)
        cat_eva = {e["id"]: e for e in eva.get("/api/exercises").get_json()["items"]}
        self.assertTrue(cat_eva[eid]["active"])

        dan.put(f"/api/exercises/{eid}/mine", json={"enabled": True})
        cat = {e["id"]: e for e in dan.get("/api/exercises").get_json()["items"]}
        self.assertTrue(cat[eid]["mine"])

    def test_friends_page_served(self):
        c = gym_app.app.test_client()
        r = c.get("/friends")
        self.assertEqual(r.status_code, 200)
        r.close()


class UpgradeTests(unittest.TestCase):

    def test_old_db_gets_tips_once(self):
        path = os.path.join(_tmp, "old.db")
        conn = db.connect(path)
        conn.executescript("""
            CREATE TABLE exercises (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
              equipment TEXT NOT NULL DEFAULT '', muscle TEXT NOT NULL,
              target TEXT NOT NULL DEFAULT '', helpers TEXT NOT NULL DEFAULT '',
              kind TEXT NOT NULL, region TEXT NOT NULL,
              stress TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT,
              height REAL, goal TEXT, freq INTEGER, injuries TEXT, created_at TEXT);
            INSERT INTO exercises (name, muscle, kind, region)
              VALUES ('Жим ногами', 'quads', 'compound', 'lower');
        """)
        db.init_db(conn)
        tips = conn.execute("SELECT tips FROM exercises WHERE name='Жим ногами'").fetchone()[0]
        self.assertIn("Поясница", tips)
        conn.execute("UPDATE exercises SET tips='' WHERE name='Жим ногами'")
        db.init_db(conn)   # второй запуск не перезаписывает очищенные советы
        tips = conn.execute("SELECT tips FROM exercises WHERE name='Жим ногами'").fetchone()[0]
        self.assertEqual(tips, "")
        self.assertIn("share", {r[1] for r in conn.execute("PRAGMA table_info(users)")})
        conn.close()


if __name__ == "__main__":
    unittest.main()
