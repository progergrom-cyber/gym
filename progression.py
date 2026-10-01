"""Подсказка рабочего веса на основе прошлой тренировки."""

FIRST_TIME = ("Первый раз: подбери вес, с которым последние 2 повтора "
              "даются тяжело, но техника не ломается.")


def fmt(w):
    """42.5 -> '42,5', 40.0 -> '40'."""
    w = round(w, 2)
    s = str(int(w)) if w == int(w) else f"{w:g}"
    return s.replace(".", ",")


def increment(ex, weight):
    dumbbells = "гантел" in (ex.get("equipment") or "").lower()
    if ex["kind"] == "compound":
        if dumbbells:
            return 2
        return 5 if weight >= 40 else 2.5
    return 1 if dumbbells else 2.5


def suggest(ex, last_sets, rep_lo, rep_hi):
    """last_sets — список (вес, повторы) с прошлого раза или None.

    Возвращает {"weight": число или None, "text": подсказка}.
    """
    sets = [(w or 0, r) for w, r in (last_sets or []) if r and r > 0]
    if not sets:
        return {"weight": None, "text": FIRST_TIME}

    work = max(w for w, _ in sets)
    work_reps = [r for w, r in sets if w == work]

    if work == 0:
        if all(r >= rep_hi for _, r in sets):
            return {"weight": 0, "text": "Все подходы на максимум повторов — "
                    "добавь отягощение или замедли темп."}
        return {"weight": 0, "text": f"Добери повторы до {rep_hi}."}

    if all(r >= rep_hi for _, r in sets):
        new = work + increment(ex, work)
        return {"weight": new,
                "text": f"В прошлый раз все подходы по {rep_hi}+ с {fmt(work)} кг"
                        f" — пробуй {fmt(new)} кг."}
    if max(work_reps) < rep_lo:
        return {"weight": work,
                "text": f"В прошлый раз было тяжело (меньше {rep_lo} повторов) — "
                        f"оставь {fmt(work)} кг или сними 2,5–5 кг."}
    return {"weight": work,
            "text": f"Оставь {fmt(work)} кг и добери повторы до {rep_hi} "
                    f"во всех подходах."}
