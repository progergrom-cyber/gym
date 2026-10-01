"""Генератор плана тренировки на день.

Модуль ничего не знает о базе данных и Flask: на вход получает обычные
словари, на выход отдаёт словарь с планом. Поэтому его легко тестировать.
"""
import random

from progression import suggest

# Группы мышц: ключ -> (название по-русски, «большая» ли группа)
MUSCLES = {
    "chest": ("Грудь", True),
    "back_lats": ("Спина: широчайшие", True),
    "back_mid": ("Спина: середина (горизонтальная тяга)", True),
    "delts_side": ("Средние дельты", False),
    "delts_rear": ("Задние дельты", False),
    "biceps": ("Бицепс и сгибатели локтя", False),
    "triceps": ("Трицепс", False),
    "quads": ("Квадрицепс", True),
    "hamstrings": ("Задняя поверхность бедра", True),
    "glutes": ("Ягодицы", True),
    "calves": ("Икры", False),
    "abs": ("Пресс", False),
    "lower_back": ("Поясница (разгибатели спины)", False),
}

# Что посоветовать добавить, если на группу мышц нет упражнений
MUSCLE_HINTS = {
    "chest": "жим от груди в тренажёре",
    "back_lats": "вертикальная тяга (верхний блок)",
    "back_mid": "горизонтальная тяга в блоке или тяга в рычажном тренажёре",
    "delts_side": "махи в стороны с гантелями или в тренажёре",
    "delts_rear": "обратная бабочка (разведение на задние дельты)",
    "biceps": "сгибание рук на бицепс",
    "triceps": "разгибание рук на трицепс в кроссовере",
    "quads": "жим ногами или разгибание ног",
    "hamstrings": "сгибание ног в тренажёре",
    "glutes": "отведение бедра в тренажёре или ягодичный мост",
    "calves": "подъём на носки",
    "abs": "скручивания на пресс",
    "lower_back": "гиперэкстензия",
}

INJURIES = {
    "knees": "колени",
    "lower_back": "поясница",
    "shoulders": "плечи",
    "elbows": "локти",
}

KINDS = {"upper": "Верх", "lower": "Низ", "full": "Фулбади"}

GOALS = {
    "hypertrophy": "Набор мышечной массы",
    "strength": "Сила",
    "maintain": "Поддержание формы",
}

# Порядок важности групп мышц для каждого типа тренировки
PRIORITY = {
    "upper": ["chest", "back_lats", "back_mid", "delts_side", "biceps",
              "triceps", "delts_rear", "abs"],
    "lower": ["quads", "hamstrings", "glutes", "calves", "lower_back", "abs"],
    "full": ["quads", "chest", "back_lats", "hamstrings", "back_mid",
             "delts_side", "glutes", "calves", "triceps", "biceps",
             "delts_rear", "abs", "lower_back"],
}

# Без этих групп тренировка считается несбалансированной (для подсказок)
ESSENTIAL = {
    "upper": ["chest", "back_lats", "back_mid", "delts_side", "delts_rear",
              "biceps", "triceps"],
    "lower": ["quads", "hamstrings", "glutes", "calves"],
    "full": ["quads", "hamstrings", "chest", "back_lats", "back_mid",
             "delts_side", "abs"],
}

CORE = {"abs", "lower_back"}

# Какие категории упражнений подходят для типа тренировки
REGIONS = {
    "upper": {"upper", "core"},
    "lower": {"lower", "core"},
    "full": {"upper", "lower", "core"},
}

WARMUP_SEC = 6 * 60       # разминка
TRANSITION_SEC = 90       # переход к следующему тренажёру и настройка
SEC_PER_REP = 4           # примерно столько длится один повтор
SET_SETUP_SEC = 10        # взять вес, сесть, начать

# Цель -> {тип упражнения: (подходы, повторы от, повторы до, отдых в секундах)}
GOAL_PARAMS = {
    "hypertrophy": {"compound": (3, 8, 12, 90), "isolation": (3, 10, 15, 60)},
    "strength": {"compound": (4, 4, 6, 180), "isolation": (3, 8, 10, 90)},
    "maintain": {"compound": (3, 10, 15, 60), "isolation": (2, 12, 15, 60)},
}


def prescribe(ex, goal, freq, minutes):
    """Сколько подходов/повторов/отдыха делать в этом упражнении."""
    params = GOAL_PARAMS.get(goal, GOAL_PARAMS["hypertrophy"])
    sets, lo, hi, rest = params[ex["kind"]]
    # Реже ходишь — больше объём за одну тренировку, чаще — меньше.
    if freq <= 2 and ex["kind"] == "compound":
        sets += 1
    elif freq == 4 and ex["kind"] == "isolation":
        sets -= 1
    elif freq >= 5:
        sets -= 1
    if minutes <= 30 and ex["kind"] == "isolation":
        sets -= 1
    sets = max(2, min(5, sets))
    return {"sets": sets, "rep_lo": lo, "rep_hi": hi, "rest": rest}


def exercise_seconds(p):
    """Время на упражнение: подходы + отдых между ними + переход."""
    set_sec = SET_SETUP_SEC + p["rep_hi"] * SEC_PER_REP
    return p["sets"] * set_sec + (p["sets"] - 1) * p["rest"] + TRANSITION_SEC


def risky_zones(ex, injuries):
    return [z for z in ex.get("stress", []) if z in injuries]


def _item(ex, profile, minutes, history, extra_sets=0):
    p = prescribe(ex, profile["goal"], profile["freq"], minutes)
    p["sets"] += extra_sets
    hint = suggest(ex, history.get(ex["id"]), p["rep_lo"], p["rep_hi"])
    return {
        "exercise_id": ex["id"],
        "name": ex["name"],
        "equipment": ex.get("equipment", ""),
        "muscle": ex["muscle"],
        "muscle_label": MUSCLES.get(ex["muscle"], (ex["muscle"],))[0],
        "kind": ex["kind"],
        "sets": p["sets"],
        "rep_lo": p["rep_lo"],
        "rep_hi": p["rep_hi"],
        "rest": p["rest"],
        "seconds": exercise_seconds(p),
        "weight": hint["weight"],
        "hint": hint["text"],
    }


def find_gaps(exercises, kind, injuries=()):
    """Группы мышц, для которых нет ни одного подходящего упражнения."""
    have = {e["muscle"] for e in exercises
            if e.get("active", True) and not risky_zones(e, injuries)}
    return [{"muscle": m, "label": MUSCLES[m][0], "hint": MUSCLE_HINTS[m]}
            for m in ESSENTIAL[kind] if m not in have]


def build_plan(exercises, profile, minutes, kind, recent_ids=(), history=None,
               seed=None):
    """Составить план.

    exercises  — список словарей каталога (id, name, muscle, kind, region,
                 stress, active, equipment);
    profile    — {"goal", "freq", "injuries"};
    recent_ids — id упражнений из прошлых тренировок (для разнообразия);
    history    — {exercise_id: [(вес, повторы), ...]} последнего выполнения.
    """
    rng = random.Random(seed)
    history = history or {}
    recent = set(recent_ids)
    injuries = set(profile.get("injuries") or [])
    budget = minutes * 60
    warnings = []

    pool = [e for e in exercises
            if e.get("active", True) and e["region"] in REGIONS[kind]
            and e["muscle"] in MUSCLES]
    safe = [e for e in pool if not risky_zones(e, injuries)]
    excluded = [e for e in pool if risky_zones(e, injuries)]
    if excluded:
        names = ", ".join(e["name"] for e in excluded)
        warnings.append(f"Исключены из-за ограничений: {names}.")

    # Случайный «жребий» для каждого упражнения, чтобы планы немного менялись
    lots = {e["id"]: rng.random() for e in safe}

    chosen = []          # список упражнений по порядку выбора
    used_ids = set()
    per_muscle = {}
    spent = WARMUP_SEC

    def pick(muscle, second_pass):
        cands = [e for e in safe if e["muscle"] == muscle
                 and e["id"] not in used_ids]
        if not cands:
            return None
        first_kind = next((c["kind"] for c in chosen
                           if c["muscle"] == muscle), None)

        def score(e):
            if second_pass:
                kind_pref = 0 if e["kind"] != first_kind else 1
            else:
                kind_pref = 0 if e["kind"] == "compound" else 1
            return (kind_pref, e["id"] in recent, lots[e["id"]])

        for e in sorted(cands, key=score):
            sec = exercise_seconds(
                prescribe(e, profile["goal"], profile["freq"], minutes))
            if spent + sec <= budget:
                return e, sec
        return None

    # Проход 1: по одному упражнению на каждую группу мышц.
    # Проход 2: если осталось время — второе упражнение на крупные группы.
    for second_pass in (False, True):
        for muscle in PRIORITY[kind]:
            limit = 2 if MUSCLES[muscle][1] else 1
            if per_muscle.get(muscle, 0) >= (limit if second_pass else 1):
                continue
            if second_pass and per_muscle.get(muscle, 0) == 0:
                continue
            res = pick(muscle, second_pass)
            if res:
                ex, sec = res
                chosen.append(ex)
                used_ids.add(ex["id"])
                per_muscle[muscle] = per_muscle.get(muscle, 0) + 1
                spent += sec

    # Порядок: базовые -> изолирующие -> пресс/поясница в конце
    order = {e["id"]: i for i, e in enumerate(chosen)}
    chosen.sort(key=lambda e: (e["muscle"] in CORE, e["kind"] != "compound",
                               order[e["id"]]))

    # Если время ещё осталось (упражнений в каталоге мало) —
    # добавляем по одному подходу, начиная с базовых упражнений.
    extra = {}
    for ex in chosen:
        p = prescribe(ex, profile["goal"], profile["freq"], minutes)
        add = SET_SETUP_SEC + p["rep_hi"] * SEC_PER_REP + p["rest"]
        if p["sets"] < 5 and spent + add <= budget:
            extra[ex["id"]] = 1
            spent += add

    items = []
    for ex in chosen:
        item = _item(ex, profile, minutes, history, extra.get(ex["id"], 0))
        alts = [a for a in safe if a["muscle"] == ex["muscle"]
                and a["id"] not in used_ids]
        alts.sort(key=lambda a: (a["id"] in recent, lots[a["id"]]))
        item["alternatives"] = [
            _item(a, profile, minutes, history, extra.get(ex["id"], 0))
            for a in alts]
        items.append(item)

    gaps = find_gaps(exercises, kind, injuries)
    if gaps:
        warnings.append("Нет упражнений на: "
                        + ", ".join(g["label"].lower() for g in gaps)
                        + ". Добавьте их в разделе «Тренажёры».")
    if not items:
        warnings.append("Не удалось подобрать ни одного упражнения: "
                        "проверьте каталог и ограничения.")
    if any(m in per_muscle for m in ("chest",)) and not (
            per_muscle.get("back_lats") or per_muscle.get("back_mid")) \
            and kind != "lower":
        warnings.append("В плане есть грудь, но нет спины — "
                        "баланс нарушен. Добавьте упражнение на спину.")

    total = WARMUP_SEC + sum(i["seconds"] for i in items)
    if items and total < budget - 15 * 60:
        warnings.append(f"План занимает около {round(total / 60)} мин из "
                        f"{minutes}: в каталоге мало подходящих упражнений.")
    return {
        "kind": kind,
        "kind_label": KINDS[kind],
        "minutes": minutes,
        "warmup_min": WARMUP_SEC // 60,
        "total_seconds": total,
        "items": items,
        "warnings": warnings,
        "gaps": gaps,
    }
