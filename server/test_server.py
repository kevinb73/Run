"""Tests du serveur (sans réseau : le client Garmin est simulé)."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

os.environ["RUNCOACH_DATA"] = tempfile.mkdtemp()
os.environ["RUNCOACH_API_KEY"] = "test-key"
sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient  # noqa: E402

import app as srv  # noqa: E402
from garmin_workout import session_to_workout  # noqa: E402

ROOT = Path(__file__).parent.parent


def plan_sessions():
    """Génère un vrai plan avec le moteur JS pour tester la conversion sur des séances réelles."""
    js = """
    import { generatePlan } from './app/js/engine/plan.js';
    const p = generatePlan({ raceDistance: 10000, raceDate: '2027-04-11', level: 'intermediate', weeklyKm: 25,
      recent: { distanceM: 10000, timeSec: 3000 }, days: [1, 3, 5, 6], longRunDay: 6 }, { today: '2026-11-14' });
    const r = generatePlan({ mode: 'fitness', fitnessGoal: 'restart', durationWeeks: 12, days: [1, 3, 6], longRunDay: 6 }, { today: '2026-11-14' });
    console.log(JSON.stringify([...p.weeks, ...r.weeks].flatMap((w) => w.sessions).filter((s) => !s.optional)));
    """
    out = subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


class FakeGarmin:
    def __init__(self):
        self.uploaded, self.scheduled, self.deleted = [], [], []

    def upload_workout(self, payload):
        self.uploaded.append(payload)
        return {"workoutId": 1000 + len(self.uploaded)}

    def schedule_workout(self, wid, d):
        self.scheduled.append((wid, d))
        return {"workoutScheduleId": 1}

    def delete_workout(self, wid):
        self.deleted.append(wid)

    def get_full_name(self):
        return "Test"

    def get_activities_by_date(self, start, end):
        return [
            {"activityId": 1, "activityName": "Course", "startTimeLocal": "2026-11-16 18:00:00", "distance": 5000,
             "duration": 2550, "averageHR": 140, "activityType": {"typeKey": "running"}},
            {"activityId": 2, "activityName": "Futsal", "startTimeLocal": "2026-11-18 20:00:00", "distance": 0,
             "duration": 3600, "activityType": {"typeKey": "indoor_soccer"}},
        ]


class ConversionTest(unittest.TestCase):
    def test_all_real_sessions_convert(self):
        sessions = plan_sessions()
        self.assertGreater(len(sessions), 50)
        for s in sessions:
            w = session_to_workout(s)
            self.assertEqual(w["sportType"]["sportTypeKey"], "running")
            steps = w["workoutSegments"][0]["workoutSteps"]
            self.assertTrue(steps)
            orders = []

            def walk(lst):
                for st in lst:
                    orders.append(st["stepOrder"])
                    if st["type"] == "RepeatGroupDTO":
                        self.assertGreaterEqual(st["numberOfIterations"], 1)
                        walk(st["workoutSteps"])
                    elif st.get("targetType", {}).get("workoutTargetTypeKey") == "pace.zone":
                        lo, hi = st["targetValueOne"], st["targetValueTwo"]
                        self.assertLess(lo, hi, "valeur 1 = allure la plus lente")
                        self.assertGreater(1000 / lo - 1000 / hi, 19, "fourchette ≥ 20 s/km")
            walk(steps)
            self.assertEqual(orders, list(range(1, len(orders) + 1)), f"ordre des étapes {s['title']}")


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeGarmin()
        srv._garmin = self.fake
        self.c = TestClient(srv.app)
        self.h = {"X-Api-Key": "test-key"}

    def test_auth_required(self):
        self.assertEqual(self.c.get("/health").status_code, 200)
        self.assertEqual(self.c.get("/garmin/status").status_code, 401)
        self.assertEqual(self.c.get("/garmin/status", headers={"X-Api-Key": "nope"}).status_code, 401)
        self.assertTrue(self.c.get("/garmin/status", headers=self.h).json()["connected"])

    def test_push_then_move_replaces_workout(self):
        s = plan_sessions()[1]
        r = self.c.post("/workouts", headers=self.h, json=s)
        self.assertEqual(r.status_code, 200, r.text)
        moved = {**s, "date": "2026-11-15"}
        r2 = self.c.post("/workouts", headers=self.h, json=moved)
        self.assertEqual(r2.json()["date"], "2026-11-15")
        self.assertEqual(self.fake.deleted, [r.json()["workoutId"]], "l'ancienne version est supprimée")
        self.assertEqual(self.fake.scheduled[-1][1], "2026-11-15")

    def test_activities_all_types(self):
        acts = self.c.get("/activities?start=2026-11-10&end=2026-11-20", headers=self.h).json()["activities"]
        self.assertEqual([a["type"] for a in acts], ["running", "indoor_soccer"])
        self.assertEqual(acts[0]["paceSecPerKm"], 510)
        self.assertIsNone(acts[1]["paceSecPerKm"])

    def test_hr_profile(self):
        self.fake.get_heart_rate_zones_v2 = lambda: [
            {"sport": "DEFAULT", "maxHeartRateUsed": 190, "restingHeartRateUsed": 60},
            {"sport": "RUNNING", "maxHeartRateUsed": 186, "restingHeartRateUsed": 55, "lactateThresholdHeartRateUsed": 168},
        ]
        self.assertEqual(self.c.get("/garmin/profile", headers=self.h).json(), {"maxHr": 186, "restHr": 55, "lthr": 168})

    def test_backup_roundtrip_and_rotation(self):
        self.assertEqual(self.c.get("/backup", headers=self.h).status_code in (200, 404), True)
        for i in range(25):
            r = self.c.put("/backup", headers=self.h, content=json.dumps({"plan": {"n": i}, "log": {}}))
            self.assertEqual(r.status_code, 200, r.text)
        got = self.c.get("/backup", headers=self.h).json()
        self.assertEqual(got["data"]["plan"]["n"], 24)
        self.assertLessEqual(len(list(srv.BACKUPS.glob("backup-*.json"))), 20)
        self.assertEqual(self.c.put("/backup", headers=self.h, content="{}").status_code, 400)
        self.assertEqual(self.c.put("/backup", headers={"X-Api-Key": "x"}, content="{}").status_code, 401)

    def test_cors(self):
        r = self.c.options("/workouts", headers={"Origin": "https://kevinb73.github.io", "Access-Control-Request-Method": "POST",
                                                 "Access-Control-Request-Headers": "x-api-key,content-type"})
        self.assertEqual(r.headers.get("access-control-allow-origin"), "https://kevinb73.github.io")
        r = self.c.options("/workouts", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
        self.assertNotEqual(r.headers.get("access-control-allow-origin"), "https://evil.example")


if __name__ == "__main__":
    unittest.main()
