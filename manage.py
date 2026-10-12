"""Служебные команды. Запускать в консоли из папки с кодом:

    python3 manage.py invite          — создать 1 инвайт-код
    python3 manage.py invite 4        — создать 4 кода
    python3 manage.py invites         — показать все коды
    python3 manage.py users           — показать пользователей
    python3 manage.py password ЛОГИН  — задать новый пароль пользователю
    python3 manage.py admin ЛОГИН     — сделать администратором (админ-панель)
    python3 manage.py unadmin ЛОГИН   — убрать права администратора
"""
import getpass
import sys

from werkzeug.security import generate_password_hash

import db

def main(args):
    conn = db.connect()
    db.init_db(conn)
    cmd = args[0] if args else ""

    if cmd == "invite":
        count = int(args[1]) if len(args) > 1 else 1
        for _ in range(count):
            code = db.new_invite_code()
            conn.execute("INSERT INTO invites (code) VALUES (?)", (code,))
            print("Инвайт-код:", code)
        conn.commit()
    elif cmd == "invites":
        for r in conn.execute(
                "SELECT i.code, i.created_at, u.username FROM invites i "
                "LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at"):
            status = f"использован ({r['username']})" if r["username"] \
                else "свободен"
            print(r["code"], r["created_at"], status)
    elif cmd == "users":
        for r in conn.execute("SELECT id, username, created_at, is_admin FROM users"):
            print(r["id"], r["username"], r["created_at"],
                  "(админ)" if r["is_admin"] else "")
    elif cmd in ("admin", "unadmin") and len(args) > 1:
        cur = conn.execute("UPDATE users SET is_admin=? WHERE username=?",
                           (1 if cmd == "admin" else 0, args[1]))
        conn.commit()
        if not cur.rowcount:
            print("Нет такого пользователя")
        elif cmd == "admin":
            print(f"{args[1]} теперь администратор. Админ-панель: Профиль → Админ-панель")
        else:
            print(f"{args[1]} больше не администратор")
    elif cmd == "password" and len(args) > 1:
        user = conn.execute("SELECT id FROM users WHERE username=?",
                            (args[1],)).fetchone()
        if not user:
            print("Нет такого пользователя")
            return
        pw = getpass.getpass("Новый пароль (не отображается при вводе): ")
        if len(pw) < 6:
            print("Пароль должен быть не короче 6 символов")
            return
        conn.execute("UPDATE users SET password_hash=? WHERE id=?",
                     (generate_password_hash(pw), user["id"]))
        conn.commit()
        print("Пароль изменён")
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
