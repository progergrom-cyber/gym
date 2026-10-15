"""Подсказка рабочего веса на основе прошлых тренировок."""
import math
from datetime import date

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


# Плато: столько тренировок подряд результат не лучше, чем был до них
PLATEAU_SESSIONS = 3
# Перерыв длиннее — это возвращение после паузы, а не плато
COMEBACK_DAYS = 21
DELOAD = 0.9              # разгрузка: −10% веса
LIGHT = 0.95              # тренировка легче этого — не «рабочая» (была разгрузка)


def e1rm(weight, reps):
    """Оценка максимума на 1 повтор (Эпли). После 12 повторов формула
    завышает, поэтому дальше повторы не считаем."""
    return weight * (1 + min(reps, 12) / 30)


def _best(sets):
    return max((e1rm(w, r) for w, r in sets), default=0)


def _top(sets):
    return max((w for w, _ in sets), default=0)


def _clean(sets):
    return [(w or 0, r) for w, r in (sets or []) if r and r > 0]


def is_plateau(sessions):
    """sessions — [{"date": "2026-10-01", "sets": [(вес, повторы)]}],
    сначала новые. True, если последние PLATEAU_SESSIONS рабочих тренировок
    подряд не превзошли лучший результат до них."""
    sessions = [dict(s, sets=_clean(s["sets"])) for s in sessions or []]
    sessions = [s for s in sessions if s["sets"]]
    n = PLATEAU_SESSIONS
    if len(sessions) < n + 1:
        return False                      # мало данных — не делаем выводов
    recent = sessions[:n]
    tops = [_top(s["sets"]) for s in recent]
    if min(tops) <= 0:
        return False                      # без отягощения — прогресс в повторах
    if min(tops) < max(tops) * LIGHT:
        return False                      # среди них была разгрузка или лёгкий день
    days = [date.fromisoformat(s["date"]) for s in sessions[:n + 1]]
    if any((a - b).days > COMEBACK_DAYS for a, b in zip(days, days[1:])):
        return False                      # был перерыв — сначала вернуть форму
    before = max(_best(s["sets"]) for s in sessions[n:])
    return max(_best(s["sets"]) for s in recent) <= before


def deload_weight(ex, work):
    """Вес на разгрузку: −10%, округлённый вниз до шага тренажёра."""
    step = increment(ex, work)
    new = math.floor(work * DELOAD / step) * step
    if new >= work:
        new = work - step
    return max(new, 0)


def suggest(ex, last_sets, rep_lo, rep_hi, sessions=None):
    """last_sets — список (вес, повторы) с прошлого раза или None.
    sessions — несколько прошлых тренировок с этим упражнением
    (см. is_plateau), чтобы заметить плато. Можно не передавать.

    Возвращает {"weight": число или None, "text": подсказка,
    "deload": True, если советуем разгрузку}.
    """
    sets = _clean(last_sets)
    sessions = sessions or []
    if not sets:
        return {"weight": None, "text": FIRST_TIME}

    work = max(w for w, _ in sets)
    work_reps = [r for w, r in sets if w == work]

    if work == 0:
        if all(r >= rep_hi for _, r in sets):
            return {"weight": 0, "text": "Все подходы на максимум повторов — "
                    "добавь отягощение или замедли темп."}
        return {"weight": 0, "text": f"Добери повторы до {rep_hi}."}

    if len(sessions) >= 2:
        before = _top(_clean(sessions[1]["sets"]))
        if 0 < work < before * LIGHT and is_plateau(sessions[1:]):
            return {"weight": before,
                    "text": f"Разгрузка позади — возвращайся к {fmt(before)} кг. "
                            f"После отдыха вес обычно снова идёт вверх."}

    if all(r >= rep_hi for _, r in sets):
        new = work + increment(ex, work)
        return {"weight": new,
                "text": f"В прошлый раз все подходы по {rep_hi}+ с {fmt(work)} кг"
                        f" — пробуй {fmt(new)} кг."}

    if is_plateau(sessions):
        new = deload_weight(ex, work)
        if 0 < new < work:
            return {"weight": new, "deload": True,
                    "text": f"🔄 Вес не растёт {PLATEAU_SESSIONS} тренировки подряд — "
                            f"сегодня разгрузка: {fmt(new)} кг, по {rep_lo} повторов, "
                            f"без отказа. Мышцы восстановятся, и в следующий раз "
                            f"вернёшься к {fmt(work)} кг."}
    if max(work_reps) < rep_lo:
        return {"weight": work,
                "text": f"В прошлый раз было тяжело (меньше {rep_lo} повторов) — "
                        f"оставь {fmt(work)} кг или сними 2,5–5 кг."}
    return {"weight": work,
            "text": f"Оставь {fmt(work)} кг и добери повторы до {rep_hi} "
                    f"во всех подходах."}
