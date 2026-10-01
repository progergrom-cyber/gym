"""Тесты генератора плана. Запуск из папки проекта:

    python -m unittest -v
"""
import itertools
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import planner  # noqa: E402
from catalog_seed import SEED  # noqa: E402
from progression import suggest  # noqa: E402


def catalog(include_spares=False):
    out = []
    for i, e in enumerate(SEED, start=1):
        e = dict(e, id=i)
        if include_spares:
            e["active"] = True
        out.append(e)
    return out


def profile(goal="hypertrophy", freq=3, injuries=()):
    return {"goal": goal, "freq": freq, "injuries": list(injuries)}


ALL_COMBOS = list(itertools.product(
    (30, 45, 60, 90), ("upper", "lower", "full"),
    ("hypertrophy", "strength", "maintain"), (2, 3, 4, 5), (False, True)))


class PlanTests(unittest.TestCase):

    def test_fits_into_time(self):
        for minutes, kind, goal, freq, spares in ALL_COMBOS:
            plan = planner.build_plan(catalog(spares), profile(goal, freq),
                                      minutes, kind, seed=1)
            with self.subTest(minutes=minutes, kind=kind, goal=goal,
                              freq=freq, spares=spares):
                self.assertLessEqual(plan["total_seconds"], minutes * 60)
                expected = planner.WARMUP_SEC + sum(
                    i["seconds"] for i in plan["items"])
                self.assertEqual(plan["total_seconds"], expected)
                self.assertGreater(len(plan["items"]), 0)

    def test_no_pointless_muscle_repeats(self):
        for minutes, kind, goal, freq, spares in ALL_COMBOS:
            plan = planner.build_plan(catalog(spares), profile(goal, freq),
                                      minutes, kind, seed=2)
            ids = [i["exercise_id"] for i in plan["items"]]
            counts = {}
            for i in plan["items"]:
                counts[i["muscle"]] = counts.get(i["muscle"], 0) + 1
            with self.subTest(minutes=minutes, kind=kind, goal=goal,
                              freq=freq, spares=spares):
                self.assertEqual(len(ids), len(set(ids)), "повтор упражнения")
                for muscle, n in counts.items():
                    limit = 2 if planner.MUSCLES[muscle][1] else 1
                    self.assertLessEqual(n, limit, muscle)

    def test_second_exercise_only_after_all_muscles_covered(self):
        plan = planner.build_plan(catalog(), profile(), 90, "upper", seed=3)
        muscles = [i["muscle"] for i in plan["items"]]
        # В каталоге на верх есть 5 групп: грудь, широчайшие, дельты,
        # бицепс, трицепс — при 90 минутах все должны попасть в план.
        for m in ("chest", "back_lats", "delts_side", "biceps", "triceps"):
            self.assertIn(m, muscles)
        self.assertEqual(muscles.count("biceps"), 1)

    def test_compound_before_isolation(self):
        for minutes, kind in itertools.product((45, 60, 90),
                                               ("upper", "lower", "full")):
            plan = planner.build_plan(catalog(True), profile(), minutes, kind,
                                      seed=4)
            kinds = [i["kind"] for i in plan["items"]
                     if i["muscle"] not in planner.CORE]
            with self.subTest(minutes=minutes, kind=kind):
                self.assertEqual(kinds, sorted(
                    kinds, key=lambda k: k != "compound"))
                core_idx = [n for n, i in enumerate(plan["items"])
                            if i["muscle"] in planner.CORE]
                if core_idx:
                    self.assertEqual(core_idx[-1], len(plan["items"]) - 1)

    def test_upper_has_chest_and_back(self):
        plan = planner.build_plan(catalog(), profile(), 45, "upper", seed=5)
        muscles = {i["muscle"] for i in plan["items"]}
        self.assertIn("chest", muscles)
        self.assertIn("back_lats", muscles)

    def test_injuries_exclude_exercises(self):
        plan = planner.build_plan(catalog(), profile(injuries=["knees"]), 60,
                                  "lower", seed=6)
        names = [i["name"] for i in plan["items"]]
        self.assertNotIn("Жим ногами", names)
        self.assertTrue(any("Исключены" in w for w in plan["warnings"]))
        for item in plan["items"]:
            for alt in item["alternatives"]:
                self.assertNotEqual(alt["name"], "Жим ногами")

    def test_variety_prefers_alternative(self):
        cat = catalog()
        lat1 = next(e for e in cat if e["name"] == "Вертикальная тяга тросовая")
        lat2 = next(e for e in cat if e["name"] == "Кроссовер: вертикальная тяга")
        for seed in range(20):
            plan = planner.build_plan(cat, profile(), 45, "upper",
                                      recent_ids=[lat1["id"]], seed=seed)
            ids = [i["exercise_id"] for i in plan["items"]]
            self.assertIn(lat2["id"], ids)
            self.assertNotIn(lat1["id"], ids)

    def test_alternatives_same_muscle(self):
        plan = planner.build_plan(catalog(), profile(), 45, "upper", seed=7)
        lat = next(i for i in plan["items"] if i["muscle"] == "back_lats")
        self.assertTrue(lat["alternatives"])
        plan_ids = {i["exercise_id"] for i in plan["items"]}
        for alt in lat["alternatives"]:
            self.assertEqual(alt["muscle"], "back_lats")
            self.assertNotIn(alt["exercise_id"], plan_ids)

    def test_photo_in_plan(self):
        cat = catalog()
        for e in cat:
            e["photo_url"] = f"/static/photos/ex{e['id']}.jpg"
        plan = planner.build_plan(cat, profile(), 45, "upper", seed=9)
        for item in plan["items"]:
            self.assertEqual(item["photo"],
                             f"/static/photos/ex{item['exercise_id']}.jpg")
            for alt in item["alternatives"]:
                self.assertTrue(alt["photo"])

    def test_gaps_reported(self):
        plan = planner.build_plan(catalog(), profile(), 60, "upper", seed=8)
        gap_muscles = {g["muscle"] for g in plan["gaps"]}
        self.assertIn("back_mid", gap_muscles)
        self.assertIn("delts_rear", gap_muscles)
        full = planner.build_plan(catalog(True), profile(), 60, "upper", seed=8)
        self.assertEqual(full["gaps"], [])

    def test_empty_catalog_survives(self):
        plan = planner.build_plan([], profile(), 60, "full")
        self.assertEqual(plan["items"], [])
        self.assertTrue(plan["warnings"])
        self.assertEqual(plan["total_seconds"], planner.WARMUP_SEC)

    def test_all_injuries_survives(self):
        plan = planner.build_plan(
            catalog(), profile(injuries=list(planner.INJURIES)), 60, "upper")
        self.assertLessEqual(plan["total_seconds"], 3600)
        for i in plan["items"]:
            self.assertEqual(i["muscle"], "back_lats")

    def test_goal_changes_reps(self):
        cat = catalog()
        strength = planner.build_plan(cat, profile("strength"), 60, "upper", seed=1)
        mass = planner.build_plan(cat, profile("hypertrophy"), 60, "upper", seed=1)
        s = next(i for i in strength["items"] if i["kind"] == "compound")
        m = next(i for i in mass["items"] if i["kind"] == "compound")
        self.assertLess(s["rep_hi"], m["rep_hi"])
        self.assertGreater(s["rest"], m["rest"])


class ProgressionTests(unittest.TestCase):
    press = {"kind": "compound", "equipment": "Matrix"}
    curl = {"kind": "isolation", "equipment": "Гантели"}

    def test_first_time(self):
        self.assertIsNone(suggest(self.press, None, 8, 12)["weight"])

    def test_increase_when_all_sets_at_top(self):
        self.assertEqual(suggest(self.press, [(50, 12), (50, 12), (50, 13)],
                                 8, 12)["weight"], 55)
        self.assertEqual(suggest(self.press, [(20, 12)] * 3, 8, 12)["weight"],
                         22.5)
        self.assertEqual(suggest(self.curl, [(10, 15)] * 3, 10, 15)["weight"],
                         11)

    def test_keep_when_not_all_at_top(self):
        self.assertEqual(suggest(self.press, [(50, 12), (50, 10), (50, 9)],
                                 8, 12)["weight"], 50)


if __name__ == "__main__":
    unittest.main()
