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
                    {i["exercise_id"] for i in p["pool"] if not i["off"]}, p["gaps"],
                    {i["exercise_id"] for i in p["pool"] if i["off"]})

        items, pool, gaps, off = plan_ids(dan)
        self.assertFalse(hidden & (items | pool))
        self.assertEqual(off, hidden)        # можно добавить вручную, с пометкой
        self.assertIn("back_lats", {g["muscle"] for g in gaps})
        items, pool, _, _ = plan_ids(eva)
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

    def test_deload_hint_in_plan(self):
        c = new_client("zhenya")
        press = ex_id("Жим от груди")
        for day in ("2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22"):
            finish(c, day, [{"exercise_id": press, "set_no": n, "weight": 50, "reps": 9}
                            for n in (1, 2, 3)])
        plan = c.post("/api/plan", json={"minutes": 90, "kind": "upper"}).get_json()["plan"]
        item = next(i for i in plan["pool"] + plan["items"] if i["exercise_id"] == press)
        self.assertTrue(item["deload"])
        self.assertEqual(item["weight"], 45)

    def test_muscle_weeks_and_month_summary(self):
        from datetime import date, timedelta
        c = new_client("kira")
        press = ex_id("Жим от груди")
        today = date.today()
        finish(c, today.isoformat(), [{"exercise_id": press, "set_no": n, "weight": 40,
                                       "reps": 10} for n in (1, 2, 3)])
        mw = c.get("/api/stats").get_json()["muscle_weeks"]
        self.assertEqual(len(mw["weeks"]), 4)
        chest = next(r for r in mw["rows"] if r["muscle"] == "chest")
        self.assertEqual(chest["sets"][-1], 3)
        self.assertEqual((chest["lo"], chest["hi"]), (10, 20))
        self.assertFalse(any(r["muscle"] == "cardio" for r in mw["rows"]))

        month = today.isoformat()[:7]
        first = today.replace(day=1)
        last_month = (first - timedelta(days=1)).replace(day=1)
        finish(c, last_month.isoformat(), [{"exercise_id": press, "set_no": 1,
                                            "weight": 30, "reps": 10}])
        finish(c, today.isoformat(), [{"exercise_id": press, "set_no": 1,
                                       "weight": 45, "reps": 8}])
        s = c.get(f"/api/summary?month={month}").get_json()
        self.assertEqual((s["visits"], s["workouts"], s["sets"]), (1, 2, 4))
        self.assertEqual(s["volume"], 40 * 10 * 3 + 45 * 8)
        self.assertEqual(s["prev"], {"visits": 1, "volume": 300})
        self.assertEqual(s["records"], [{"name": "Жим от груди", "from": 30, "to": 45}])
        self.assertEqual(c.get("/api/summary?month=2026-13").status_code, 400)
        empty = c.get("/api/summary?month=2020-01").get_json()
        self.assertEqual((empty["workouts"], empty["records"]), (0, []))

    def test_week_info_and_suggestion(self):
        import datetime
        c = new_client("zoya")
        week = c.get("/api/me").get_json()["week"]
        self.assertEqual((week["visits"], week["goal"], week["suggest"]), (0, 3, "upper"))
        self.assertIsNone(week["last"])
        today = datetime.date.today().isoformat()
        finish(c, today, [{"exercise_id": ex_id("Жим от груди"), "set_no": 1,
                           "weight": 40, "reps": 10}], kind="upper")
        week = c.get("/api/me").get_json()["week"]
        self.assertEqual(week["visits"], 1)
        self.assertEqual(week["suggest"], "lower")
        self.assertEqual(week["last"]["kind_label"], "Верх")

    def test_pair_workout(self):
        host = new_client("pasha")
        guest = new_client("rita")
        # Рита выключила себе жим ногами — в общем плане его быть не должно
        leg_press = ex_id("Жим ногами")
        guest.put(f"/api/exercises/{leg_press}/mine", json={"enabled": False})
        r = host.post("/api/pair", json={"partner": "rita", "minutes": 60, "kind": "lower"})
        self.assertEqual(r.status_code, 200, r.get_json())
        hplan = r.get_json()["plan"]
        ids = [i["exercise_id"] for i in hplan["items"]]
        self.assertTrue(ids)
        self.assertNotIn(leg_press, ids)
        self.assertEqual(hplan["pair"]["partner"], "rita")

        invite = guest.get("/api/me").get_json()["pair_invite"]
        self.assertEqual(invite["host"], "pasha")
        gplan = guest.post(f"/api/pair/{invite['id']}/join", json={}).get_json()["plan"]
        self.assertEqual([i["exercise_id"] for i in gplan["items"]], ids)   # тот же порядок
        self.assertEqual(gplan["pair"]["partner"], "pasha")
        self.assertIsNone(guest.get("/api/me").get_json()["pair_invite"])

        # Прогресс: каждый видит прогресс другого
        host.put(f"/api/pair/{invite['id']}/progress",
                 json={"cur": 2, "count": len(ids), "name": "Тяга", "done": 5, "total": 20})
        got = guest.put(f"/api/pair/{invite['id']}/progress",
                        json={"cur": 1, "count": len(ids), "name": "Мост", "done": 2,
                              "total": 18}).get_json()
        self.assertEqual(got["partner"]["done"], 5)

        # Чужой не может подглядеть
        stranger = new_client("sava")
        self.assertEqual(stranger.put(f"/api/pair/{invite['id']}/progress",
                                      json={}).status_code, 404)

        # Завершаем — в ленте видно «вместе с»
        sets = [{"exercise_id": ids[0], "set_no": 1, "weight": 40, "reps": 10}]
        for c, plan in ((host, hplan), (guest, gplan)):
            c.post(f"/api/workouts/{plan['workout_id']}/finish",
                   json={"date": "2026-10-12", "kind": "lower", "minutes": 60, "sets": sets})
            c.put("/api/friends/share", json={"share": True})
        feed = host.get("/api/friends").get_json()["feed"]
        rita = next(w for w in feed if w["username"] == "rita")
        self.assertEqual(rita["partner"], "pasha")
        self.assertEqual(host.get("/api/me").get_json()["week"]["last"]["partner"], "rita")

    def test_group_of_three(self):
        host = new_client("gena")
        a = new_client("dina")
        b = new_client("egor")
        press = ex_id("Жим ногами")
        b.put(f"/api/exercises/{press}/mine", json={"enabled": False})
        r = host.post("/api/pair", json={"partners": ["dina", "egor"],
                                         "minutes": 60, "kind": "lower"})
        self.assertEqual(r.status_code, 200, r.get_json())
        hplan = r.get_json()["plan"]
        self.assertEqual(hplan["pair"]["partners"], ["dina", "egor"])
        self.assertNotIn(press, [i["exercise_id"] for i in hplan["items"]])
        # Больше двух друзей звать нельзя
        new_client("fima")
        self.assertEqual(host.post("/api/pair", json={
            "partners": ["dina", "egor", "fima"], "minutes": 60,
            "kind": "lower"}).status_code, 400)

        inv = a.get("/api/me").get_json()["pair_invite"]
        self.assertEqual((inv["host"], inv["others"]), ("gena", ["egor"]))
        pid = inv["id"]
        a.post(f"/api/pair/{pid}/join", json={})
        b.post(f"/api/pair/{pid}/decline", json={})
        a.put(f"/api/pair/{pid}/progress", json={"cur": 1, "done": 3, "name": "<b>x</b>"})
        got = host.put(f"/api/pair/{pid}/progress", json={"cur": 2}).get_json()
        by_name = {m["name"]: m for m in got["partners"]}
        self.assertEqual(by_name["dina"]["progress"]["done"], 3)
        self.assertEqual(by_name["egor"]["status"], "declined")
        sets = [{"exercise_id": hplan["items"][0]["exercise_id"], "set_no": 1,
                 "weight": 40, "reps": 10}]
        host.post(f"/api/workouts/{hplan['workout_id']}/finish",
                  json={"date": "2026-10-12", "kind": "lower", "minutes": 60, "sets": sets})
        self.assertEqual(host.get("/api/me").get_json()["week"]["last"]["partner"], "dina")

    def test_reactions(self):
        a = new_client("tima")
        b = new_client("ula")
        press = ex_id("Жим от груди")
        finish(a, "2026-10-10", [{"exercise_id": press, "set_no": 1, "weight": 40, "reps": 10}])
        wid = a.get("/api/workouts").get_json()["items"][0]["id"]
        # Тима ещё не делится — Уля не может реагировать
        self.assertEqual(b.post(f"/api/workouts/{wid}/react", json={"emoji": "🔥"}).status_code, 404)
        a.put("/api/friends/share", json={"share": True})
        r = b.post(f"/api/workouts/{wid}/react", json={"emoji": "🔥"}).get_json()["reactions"]
        self.assertEqual((r[0]["emoji"], r[0]["count"], r[0]["mine"]), ("🔥", 1, True))
        self.assertEqual(b.post(f"/api/workouts/{wid}/react",
                                json={"emoji": "😈"}).status_code, 400)
        last = a.get("/api/me").get_json()["week"]["last"]
        self.assertEqual(last["reactions"][0]["names"], ["ula"])
        # повторное нажатие снимает
        r = b.post(f"/api/workouts/{wid}/react", json={"emoji": "🔥"}).get_json()["reactions"]
        self.assertEqual(r, [])

    def test_admin_panel(self):
        boss = new_client("boss")
        user = new_client("vasya")
        # Обычному пользователю — нельзя
        self.assertEqual(boss.get("/api/admin/overview").status_code, 403)
        conn = db.connect()
        conn.execute("UPDATE users SET is_admin=1 WHERE username='boss'")
        conn.commit()
        vid = conn.execute("SELECT id FROM users WHERE username='vasya'").fetchone()[0]
        conn.close()
        self.assertTrue(boss.get("/api/me").get_json()["profile"]["is_admin"])
        self.assertEqual(user.get("/api/admin/overview").status_code, 403)

        ov = boss.get("/api/admin/overview").get_json()
        self.assertIn("vasya", [u["username"] for u in ov["users"]])

        codes = boss.post("/api/admin/invites", json={"count": 2}).get_json()["codes"]
        self.assertEqual(len(codes), 2)
        self.assertEqual(boss.delete(f"/api/admin/invites/{codes[0]}").status_code, 200)

        # Сброс пароля: старый не подходит, временный — подходит
        pw = boss.post(f"/api/admin/users/{vid}/password", json={}).get_json()["password"]
        c = gym_app.app.test_client()
        self.assertEqual(c.post("/api/login", json={"username": "vasya",
                                                    "password": "secret123"}).status_code, 401)
        self.assertEqual(c.post("/api/login", json={"username": "vasya",
                                                    "password": pw}).status_code, 200)

        # Блокировка: вход запрещён и текущая сессия перестаёт работать
        boss.post(f"/api/admin/users/{vid}/block", json={"blocked": True})
        self.assertEqual(c.get("/api/me").status_code, 401)
        self.assertEqual(gym_app.app.test_client().post(
            "/api/login", json={"username": "vasya", "password": pw}).status_code, 403)
        boss.post(f"/api/admin/users/{vid}/block", json={"blocked": False})

        # Себя заблокировать/удалить нельзя
        bid = ov["me"]
        self.assertEqual(boss.post(f"/api/admin/users/{bid}/block",
                                   json={"blocked": True}).status_code, 400)

        # Журнал каталога
        eid = ex_id("Подъём на носки сидя")
        ex = next(e for e in user.get("/api/exercises").get_json()["items"] if e["id"] == eid)
        c.post("/api/login", json={"username": "vasya", "password": pw})
        r = c.put(f"/api/exercises/{eid}", json=dict(ex, name="Икры сидя"))
        self.assertEqual(r.status_code, 200)
        log = boss.get("/api/admin/log").get_json()["items"]
        self.assertEqual(log[0]["username"], "vasya")
        self.assertIn("Икры сидя", log[0]["action"])

        # Резервная копия — настоящий файл SQLite
        r = boss.get("/api/admin/backup")
        self.assertTrue(r.data.startswith(b"SQLite format 3"))
        r.close()
        r = boss.get("/api/admin/photos.zip")
        self.assertEqual(r.status_code, 200)
        r.close()

        # Удаление: нужно подтверждение логином
        finish(c, "2026-10-10", [{"exercise_id": eid, "set_no": 1, "weight": 40, "reps": 10}])
        self.assertEqual(boss.post(f"/api/admin/users/{vid}/delete",
                                   json={"confirm": "nope"}).status_code, 400)
        self.assertEqual(boss.post(f"/api/admin/users/{vid}/delete",
                                   json={"confirm": "vasya"}).status_code, 200)
        conn = db.connect()
        self.assertIsNone(conn.execute("SELECT 1 FROM users WHERE id=?", (vid,)).fetchone())
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM workouts WHERE user_id=?",
                                      (vid,)).fetchone()[0], 0)
        conn.execute("UPDATE exercises SET name='Подъём на носки сидя' WHERE id=?", (eid,))
        conn.commit()
        conn.close()

    def test_friends_page_served(self):
        c = gym_app.app.test_client()
        r = c.get("/friends")
        self.assertEqual(r.status_code, 200)
        r.close()


class UpgradeTests(unittest.TestCase):

    def test_old_global_off_becomes_personal(self):
        path = os.path.join(_tmp, "old_toggle.db")
        conn = db.connect(path)
        db.init_db(conn)
        conn.execute("DELETE FROM meta WHERE key='personal_v1'")
        conn.execute("INSERT INTO users (username, password_hash) VALUES ('a', 'x'), ('b', 'x')")
        conn.execute("UPDATE exercises SET active=0 WHERE name='Молот с гантелями'")
        conn.commit()
        db.init_db(conn)
        hammer = conn.execute("SELECT id, active FROM exercises WHERE name='Молот с гантелями'").fetchone()
        self.assertEqual(hammer["active"], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM user_hidden WHERE exercise_id=?",
                                      (hammer["id"],)).fetchone()[0], 2)
        spare = conn.execute("SELECT active FROM exercises WHERE name='Скручивания на пресс'").fetchone()
        self.assertEqual(spare["active"], 0)
        conn.close()

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


class AvatarTest(unittest.TestCase):
    PNG = bytes([0x89]) + b"PNG" + bytes([13, 10, 26, 10]) + b"0" * 40

    def test_upload_replace_delete(self):
        import io
        c = new_client("ava")
        self.assertIsNone(c.get("/api/me").get_json()["profile"]["avatar_url"])
        r = c.post("/api/profile/photo", data={"photo": (io.BytesIO(self.PNG), "a.png")},
                   content_type="multipart/form-data")
        first = r.get_json()["avatar_url"]
        self.assertTrue(first.endswith(".png"))
        self.assertEqual(c.get("/api/me").get_json()["profile"]["avatar_url"], first)
        path = os.path.join(gym_app.PHOTO_DIR, os.path.basename(first))
        self.assertTrue(os.path.exists(path))
        # не картинка — отказ
        r = c.post("/api/profile/photo", data={"photo": (io.BytesIO(b"hello"), "a.txt")},
                   content_type="multipart/form-data")
        self.assertEqual(r.status_code, 400)
        # замена удаляет старый файл
        second = c.post("/api/profile/photo", data={"photo": (io.BytesIO(self.PNG), "b.png")},
                        content_type="multipart/form-data").get_json()["avatar_url"]
        self.assertNotEqual(first, second)
        self.assertFalse(os.path.exists(path))
        c.delete("/api/profile/photo")
        self.assertIsNone(c.get("/api/me").get_json()["profile"]["avatar_url"])
        self.assertFalse(os.path.exists(os.path.join(gym_app.PHOTO_DIR, os.path.basename(second))))

    def test_summary(self):
        c = new_client("summ")
        s = c.get("/api/profile/summary").get_json()
        self.assertEqual((s["workouts"], s["records"], s["streak"]), (0, 0, 0))
        self.assertIsNone(s["since"])



class NewFeaturesTest(unittest.TestCase):

    def test_feel_tired_once_a_week(self):
        c = new_client("tired1")
        plan = c.post("/api/plan", json={"minutes": 60, "kind": "upper", "feel": "tired",
                                         "date": "2026-10-01"}).get_json()["plan"]
        self.assertEqual(plan["feel"], "tired")
        self.assertIn("усталость", plan["warnings"][0])
        item = plan["items"][0]
        c.post(f"/api/workouts/{plan['workout_id']}/finish",
               json={"date": "2026-10-01", "kind": "upper", "minutes": 60, "feel": "tired",
                     "sets": [{"exercise_id": item["exercise_id"], "set_no": 1,
                               "weight": 40, "reps": 10, "effort": 3}]})
        conn = db.connect()
        row = conn.execute("SELECT w.feel, s.effort FROM workouts w JOIN sets s "
                           "ON s.workout_id = w.id WHERE w.id=?",
                           (plan["workout_id"],)).fetchone()
        conn.close()
        self.assertEqual((row["feel"], row["effort"]), ("tired", 3))
        # Через пару дней снова «устал» — объём обычный, только без прибавки
        import app as a
        real = a.date
        class FakeDate(real):
            @classmethod
            def today(cls):
                return real(2026, 10, 3)
        a.date = FakeDate
        try:
            again = c.post("/api/plan", json={"minutes": 60, "kind": "upper", "feel": "tired",
                                              "date": "2026-10-03"}).get_json()["plan"]
        finally:
            a.date = real
        self.assertIn("уже облегчали", again["warnings"][0])

    def test_templates(self):
        c = new_client("tmpl")
        ids = [ex_id("Жим от груди")]
        r = c.post("/api/templates", json={"name": "Моя грудь", "kind": "upper",
                                           "minutes": 45, "ex_ids": ids + [999999]})
        item = r.get_json()["item"]
        self.assertEqual(item["exercises"], ["Жим от груди"])
        self.assertEqual(len(c.get("/api/templates").get_json()["items"]), 1)
        plan = c.post(f"/api/templates/{item['id']}/plan",
                      json={"date": "2026-10-02"}).get_json()["plan"]
        self.assertEqual([i["exercise_id"] for i in plan["items"]], ids)
        self.assertEqual(plan["template"], "Моя грудь")
        # чужой шаблон не виден
        other = new_client("tmpl2")
        self.assertEqual(other.post(f"/api/templates/{item['id']}/plan",
                                    json={}).status_code, 404)
        self.assertEqual(c.post("/api/templates", json={"name": "", "ex_ids": ids}).status_code, 400)
        c.delete(f"/api/templates/{item['id']}")
        self.assertEqual(c.get("/api/templates").get_json()["items"], [])

    def test_schedule_and_calendar(self):
        c = new_client("sched")
        self.assertEqual(c.put("/api/profile/schedule",
                               json={"days": [0, 2, 9], "time": "19:00"}).status_code, 400)
        self.assertEqual(c.put("/api/profile/schedule",
                               json={"days": [0, 2], "time": "25:00"}).status_code, 400)
        r = c.put("/api/profile/schedule", json={"days": [4, 0, 2], "time": "07:30",
                                                  "minutes": 45})
        self.assertEqual(r.get_json()["schedule"]["days"], [0, 2, 4])
        me = c.get("/api/me").get_json()
        self.assertEqual(me["profile"]["schedule"]["time"], "07:30")
        self.assertIsNotNone(me["week"]["today_planned"])
        path = c.get("/api/calendar").get_json()["path"]
        self.assertEqual(c.get("/api/calendar").get_json()["path"], path)
        ics = gym_app.app.test_client().get(path)   # без входа — по секретной ссылке
        self.assertEqual(ics.status_code, 200)
        text = ics.get_data(as_text=True)
        self.assertIn("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR", text)
        self.assertIn("T073000", text)
        self.assertIn("DURATION:PT45M", text)
        self.assertEqual(gym_app.app.test_client().get("/cal/wrong.ics").status_code, 404)
        c.post("/api/calendar/reset")
        self.assertEqual(gym_app.app.test_client().get(path).status_code, 404)
        # пустой список дней — расписание выключено
        c.put("/api/profile/schedule", json={"days": []})
        self.assertIsNone(c.get("/api/me").get_json()["profile"]["schedule"])

    def test_schedule_week_rotation(self):
        from datetime import date
        out = gym_app.schedule_week({"days": [0, 2, 4]}, date(2026, 10, 12), "2026-10-12",
                                    {}, "upper", False)
        self.assertEqual([d["kind"] for d in out], ["upper", "lower", "upper"])
        out = gym_app.schedule_week({"days": [0, 2, 4]}, date(2026, 10, 14), "2026-10-12",
                                    {"2026-10-14": ["upper"]}, "lower", False)
        self.assertEqual([(d["date"], d["kind"]) for d in out], [("2026-10-16", "lower")])


if __name__ == "__main__":
    unittest.main()
