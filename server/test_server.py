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
os.environ["RUNCOACH_NO_SCHEDULER"] = "1"  # pas de thread de planification pendant les tests
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
             "duration": 2550, "averageHR": 140, "maxHR": 158, "calories": 412, "elevationGain": 23.4,
             "averageRunningCadenceInStepsPerMinute": 162.3, "aerobicTrainingEffect": 2.4, "activityTrainingLoad": 48,
             "activityType": {"typeKey": "running"}},
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


class StrengthTest(unittest.TestCase):
    def test_strength_sessions_convert(self):
        js = """
        import { generatePlan } from './app/js/engine/plan.js';
        const p = generatePlan({ mode: 'fitness', fitnessGoal: 'regular', durationWeeks: 12, level: 'intermediate', weeklyKm: 5, longestRunKm: 3,
          days: [0, 2, 6], longRunDay: 6, otherSports: [{ day: 2, kind: 'futsal' }, { day: 5, kind: 'referee' }] }, { today: '2026-11-14' });
        console.log(JSON.stringify(p.weeks.flatMap((w) => w.sessions).filter((s) => s.type === 'strength')));
        """
        out = subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True)
        sessions = json.loads(out.stdout)
        self.assertGreaterEqual(len(sessions), 20)
        for s in sessions:
            w = session_to_workout(s)
            self.assertEqual(w["sportType"]["sportTypeKey"], "strength_training")
            groups = w["workoutSegments"][0]["workoutSteps"]
            self.assertEqual(len(groups), 5)
            orders = []
            for g in groups:
                orders.append(g["stepOrder"])
                ex, rest = g["workoutSteps"]
                orders += [ex["stepOrder"], rest["stepOrder"]]
                self.assertTrue(ex["category"] and ex["exerciseName"])
            self.assertEqual(orders, list(range(1, len(orders) + 1)))
            self.assertLess(w["estimatedDurationInSecs"], 20 * 60)


class TargetTest(unittest.TestCase):
    def test_easy_run_never_pushes_to_speed_up(self):
        s = {"id": "x", "date": "2026-11-16", "title": "Footing", "min": 40, "steps": [
            {"kind": "run", "dur": {"type": "distance", "m": 4000}, "zone": "E", "pace": [476, 544], "note": ""},
            {"kind": "repeat", "times": 5, "steps": [
                {"kind": "run", "dur": {"type": "time", "s": 20}, "zone": "R", "pace": [366, 374], "note": ""},
                {"kind": "recovery", "dur": {"type": "time", "s": 60}, "zone": None, "pace": None, "note": ""}]}]}
        steps = session_to_workout(s)["workoutSegments"][0]["workoutSteps"]
        easy = steps[0]
        self.assertAlmostEqual(1000 / easy["targetValueTwo"], 476, delta=1)  # borne rapide inchangée
        self.assertAlmostEqual(1000 / easy["targetValueOne"], 544 + 90, delta=1)  # borne lente élargie
        stride = steps[1]["workoutSteps"][0]
        self.assertEqual(stride["targetType"]["workoutTargetTypeKey"], "no.target")


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeGarmin()
        srv._garmin = self.fake
        self.c = TestClient(srv.app)
        self.h = {"X-Api-Key": "test-key"}

    def test_auth_required(self):
        h = self.c.get("/health")
        self.assertEqual(h.status_code, 200)
        self.assertTrue(h.json()["version"])
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
        self.assertEqual((acts[0]["calories"], acts[0]["maxHr"], acts[0]["cadence"]), (412, 158, 162.3))
        self.assertIsNone(acts[1]["paceSecPerKm"])

    def test_readiness(self):
        self.fake.get_training_readiness = lambda d: [
            {"timestamp": "2026-11-16T06:00", "score": 31, "level": "LOW", "sleepScore": 58, "recoveryTime": 1500},
            {"timestamp": "2026-11-16T05:00", "score": 80, "level": "HIGH"},
        ]
        self.fake.get_hrv_data = lambda d: {"hrvSummary": {"status": "UNBALANCED"}}
        r = self.c.get("/readiness?day=2026-11-16", headers=self.h).json()
        self.assertEqual((r["score"], r["level"], r["sleepScore"], r["hrvStatus"], r["recoveryHours"]), (31, "LOW", 58, "UNBALANCED", 25))
        # Sources indisponibles : réponse vide mais valide
        del self.fake.get_training_readiness, self.fake.get_hrv_data
        r = self.c.get("/readiness?day=2026-11-16", headers=self.h).json()
        self.assertIsNone(r["score"])

    def test_laps(self):
        self.fake.get_activity_splits = lambda aid: {"lapDTOs": [
            {"distance": 2500.4, "duration": 900.2, "averageHR": 130},
            {"distance": 1318.6, "duration": 360.0, "averageHR": 178},
        ]}
        laps = self.c.get("/activities/42/laps", headers=self.h).json()["laps"]
        self.assertEqual(laps[1], {"distanceM": 1319, "durationSec": 360, "avgHr": 178, "maxHr": None})

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


class McpTest(unittest.TestCase):
    """Connecteur ChatGPT : adresse secrète, protocole, 5 outils en lecture seule sur une vraie sauvegarde."""

    def setUp(self):
        os.environ["RUNCOACH_TODAY"] = "2026-11-24"
        self.addCleanup(os.environ.pop, "RUNCOACH_TODAY", None)
        srv._garmin = FakeGarmin()
        self.c = TestClient(srv.app)
        self.h = {"X-Api-Key": "test-key"}
        js = """
        import { generatePlan } from './app/js/engine/plan.js';
        const plan = generatePlan({ mode: 'fitness', fitnessGoal: 'regular', durationWeeks: 12, level: 'intermediate', weeklyKm: 5, longestRunKm: 3,
          days: [0, 2, 6], longRunDay: 6, otherSports: [{ day: 2, kind: 'futsal' }, { day: 5, kind: 'referee' }] }, { today: '2026-11-14' });
        const s = plan.weeks[0].sessions.find((x) => x.type === 'easy');
        const log = { [s.id]: { done: true, feel: 'ok', actualKm: 2.4, durationSec: 1300, avgHr: 150, calories: 230, garminId: 1, source: 'garmin',
          pain: { zone: 'knee', level: 'light' }, analysis: { verdict: 'success', details: ['ok'], note: null } } };
        const acts = { 1: { id: 1, date: s.date, type: 'running', distanceKm: 2.4, durationSec: 1300, avgHr: 150, calories: 230, trainingLoad: 40 },
          2: { id: 2, date: '2026-11-18', type: 'indoor_soccer', durationSec: 3600, calories: 600 } };
        console.log(JSON.stringify({ plan, log, acts, known: { 1: s.id }, hr: { maxHr: 190, restHr: 55 } }));
        """
        out = subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True)
        self.assertEqual(self.c.put("/backup", headers=self.h, content=out.stdout).status_code, 200)
        self.path = self.c.get("/mcp-url", headers=self.h).json()["path"]

    def rpc(self, method, params=None, mid=1):
        r = self.c.post(self.path, json={"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_secret_url(self):
        self.assertEqual(self.c.get("/mcp-url").status_code, 401, "adresse donnée seulement avec la clé")
        self.assertEqual(self.c.post("/mcp/mauvais", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code, 404)
        self.assertEqual(len(self.path.split("/")[-1]), 32)

    def test_protocol(self):
        init = self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "chatgpt"}})
        self.assertEqual(init["result"]["protocolVersion"], "2025-06-18")
        self.assertIn("tools", init["result"]["capabilities"])
        n = self.c.post(self.path, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertEqual(n.status_code, 202)
        tools = self.rpc("tools/list")["result"]["tools"]
        self.assertEqual({t["name"] for t in tools}, {"profil_et_plan", "seances_recentes", "bilan_mensuel", "forme_et_charge", "douleurs_et_ajustements",
                                                      "proposer_modification", "propositions"})
        self.assertEqual([t["name"] for t in tools if not t["annotations"]["readOnlyHint"]], ["proposer_modification"], "seul outil qui écrit : la proposition")
        self.assertEqual(self.rpc("nope")["error"]["code"], -32601)

    def test_tools_read_backup(self):
        for name, args in [("profil_et_plan", {}), ("seances_recentes", {"jours": 30}), ("bilan_mensuel", {"mois": "2026-11"}),
                           ("forme_et_charge", {}), ("douleurs_et_ajustements", {})]:
            res = self.rpc("tools/call", {"name": name, "arguments": args})["result"]
            self.assertFalse(res["isError"], f"{name} : {res}")
            data = res["structuredContent"]
            self.assertEqual(json.loads(res["content"][0]["text"]), data)
            self.assertTrue(data["donnees_au"])
        plan = self.rpc("tools/call", {"name": "profil_et_plan", "arguments": {}})["result"]["structuredContent"]
        self.assertEqual(plan["jours_course"], ["lundi", "mercredi", "dimanche"])
        self.assertEqual(plan["jour_sortie_longue"], "dimanche")
        self.assertEqual(plan["sports_si_il_y_va"], [{"jour": "mercredi", "sport": "futsal"}, {"jour": "samedi", "sport": "arbitrage"}])
        self.assertTrue(all(s["jour"] in ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche") for s in plan["prochaines_seances"]))
        self.assertTrue(plan["prochaines_seances"])
        rec = self.rpc("tools/call", {"name": "seances_recentes", "arguments": {"jours": 60}})["result"]["structuredContent"]
        done = [s for s in rec["seances_du_plan"] if s["statut"] == "faite"]
        self.assertEqual(done[0]["allure"], "9'02/km")
        self.assertEqual(done[0]["douleur"]["zone"], "knee")
        mois = self.rpc("tools/call", {"name": "bilan_mensuel", "arguments": {"mois": "2026-11"}})["result"]["structuredContent"]
        self.assertEqual(mois["calories_garmin"], 830)
        forme = self.rpc("tools/call", {"name": "forme_et_charge", "arguments": {}})["result"]["structuredContent"]
        self.assertIn("ratio_aigu_chronique", forme)
        douleurs = self.rpc("tools/call", {"name": "douleurs_et_ajustements", "arguments": {}})["result"]["structuredContent"]
        self.assertEqual(len(douleurs["douleurs_signalees"]), 1)
        self.assertEqual(self.rpc("tools/call", {"name": "inconnu"})["error"]["code"], -32602)


class ProposalTest(McpTest):
    """ChatGPT dépose des propositions validées contre le plan ; l'app les liste puis les marque appliquées / refusées."""

    def setUp(self):
        super().setUp()
        srv.PROPOSALS.unlink(missing_ok=True)

    def call(self, name, args):
        return self.rpc("tools/call", {"name": name, "arguments": args})["result"]

    def test_write_tool_flagged(self):
        tools = {t["name"]: t for t in self.rpc("tools/list")["result"]["tools"]}
        self.assertFalse(tools["proposer_modification"]["annotations"]["readOnlyHint"])
        self.assertTrue(tools["propositions"]["annotations"]["readOnlyHint"])

    def test_propose_validate_list_decide(self):
        plan = self.call("profil_et_plan", {})["structuredContent"]
        nxt = next(s for s in plan["prochaines_seances"] if s["type"] in ("easy", "long"))
        # Proposition invalide : date sans séance, raison absente, déplacement hors semaine
        self.assertTrue(self.call("proposer_modification", {"action": "sauter", "date": nxt["date"], "raison": ""})["isError"])
        self.assertTrue(self.call("proposer_modification", {"action": "deplacer", "date": nxt["date"], "nouvelle_date": "2027-01-01", "raison": "r"})["isError"])
        self.assertTrue(self.call("proposer_modification", {"action": "pause", "jours": 90, "raison": "r"})["isError"])
        # Valide
        r = self.call("proposer_modification", {"action": "alleger", "date": nxt["date"], "raison": "Futsal la veille : on garde des jambes."})
        self.assertFalse(r["isError"], r)
        prop = r["structuredContent"]["proposition"]
        self.assertEqual(prop["status"], "pending")
        self.assertEqual(prop["seance_id"] is not None, True)
        # L'app la voit (avec la clé), puis l'applique
        pend = self.c.get("/proposals?status=pending", headers=self.h).json()["proposals"]
        self.assertEqual([p["id"] for p in pend], [prop["id"]])
        self.assertEqual(self.c.get("/proposals").status_code, 401)
        self.assertEqual(self.c.post(f"/proposals/{prop['id']}", headers=self.h, json={"status": "applied"}).json()["status"], "applied")
        self.assertEqual(self.c.get("/proposals?status=pending", headers=self.h).json()["proposals"], [])
        st = self.call("propositions", {})["structuredContent"]["propositions"]
        self.assertEqual(st[-1]["status"], "applied")
        self.assertEqual(self.c.post("/proposals/inconnue", headers=self.h, json={"status": "refused"}).status_code, 404)

    def test_max_pending(self):
        plan = self.call("profil_et_plan", {})["structuredContent"]
        d = plan["prochaines_seances"][0]["date"]
        for _ in range(5):
            self.assertFalse(self.call("proposer_modification", {"action": "sauter", "date": d, "raison": "r"})["isError"])
        self.assertTrue(self.call("proposer_modification", {"action": "sauter", "date": d, "raison": "r"})["isError"], "pas de déluge de propositions")


class PushLogicTest(unittest.TestCase):
    """Logique « quelle notification est due » (pure, sans réseau ni pywebpush)."""

    def setUp(self):
        import push
        self.push = push
        js = """
        import { generatePlan } from './app/js/engine/plan.js';
        const plan = generatePlan({ mode: 'fitness', fitnessGoal: 'regular', durationWeeks: 12, level: 'intermediate', weeklyKm: 5, longestRunKm: 3,
          days: [0, 2, 6], longRunDay: 6, otherSports: [{ day: 2, kind: 'futsal' }, { day: 5, kind: 'referee' }] }, { today: '2026-11-14' });
        console.log(JSON.stringify({ plan, log: {} }));
        """
        self.state = json.loads(subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True).stdout)
        self.prefs = {**push.default_prefs(), "subscription": {"endpoint": "https://x"}, "tz": "Europe/Paris"}

    def at(self, iso):  # datetime UTC
        from datetime import datetime, timezone
        return datetime.fromisoformat(iso).replace(tzinfo=timezone.utc)

    def test_day_and_eve(self):
        # Lundi 16 est une séance (course + renfo). Dimanche 15 au soir 20h (19h UTC) → « demain ».
        due, last = self.push.notifications_due(self.prefs, self.state, self.at("2026-11-15T19:00:00"))
        self.assertEqual([n["kind"] for n in due], ["eve"])
        self.assertIn("Demain", due[0]["title"])
        self.assertIn("km", due[0]["body"])
        self.assertEqual(last["eve"], "2026-11-15")
        # Lundi 16 à 7h (6h UTC) → « aujourd'hui »
        due, _ = self.push.notifications_due(self.prefs, self.state, self.at("2026-11-16T06:00:00"))
        self.assertEqual([n["kind"] for n in due], ["day"])
        self.assertIn("Aujourd'hui", due[0]["title"])

    def test_once_per_day(self):
        p = {**self.prefs, "last_sent": {"eve": "2026-11-15"}}
        due, _ = self.push.notifications_due(p, self.state, self.at("2026-11-15T19:30:00"))
        self.assertEqual(due, [], "pas deux fois le même soir")

    def test_window_closes(self):
        due, _ = self.push.notifications_due(self.prefs, self.state, self.at("2026-11-15T22:30:00"))
        self.assertEqual(due, [], "plus de 2 h après l'heure prévue : on laisse tomber")

    def test_before_time(self):
        due, _ = self.push.notifications_due(self.prefs, self.state, self.at("2026-11-15T18:00:00"))
        self.assertEqual(due, [])

    def test_rest_day_silent(self):
        # Mardi 17 : repos (futsal facultatif seul) → pas de notif « aujourd'hui »
        due, _ = self.push.notifications_due(self.prefs, self.state, self.at("2026-11-17T06:00:00"))
        self.assertEqual([n for n in due if n["kind"] == "day"], [])

    def test_disabled(self):
        p = {**self.prefs, "eve": {"enabled": False, "time": "20:00"}, "day": {"enabled": False, "time": "07:00"}}
        self.assertEqual(self.push.notifications_due(p, self.state, self.at("2026-11-16T06:00:00"))[0], [])

    def test_done_session_no_dayof(self):
        run = next(s for w in self.state["plan"]["weeks"] for s in w["sessions"] if s["date"] == "2026-11-16" and s["type"] != "strength")
        st = {**self.state, "log": {run["id"]: {"done": True}}}
        # Renfo pas fait → il reste une notif, mais plus le footing en titre
        due, _ = self.push.notifications_due(self.prefs, st, self.at("2026-11-16T06:00:00"))
        self.assertTrue(all("Footing" not in n["title"] for n in due) or not due)


class PushApiTest(unittest.TestCase):
    """Endpoints push + _push_tick, avec envoi simulé (pas de vrai web push)."""

    def setUp(self):
        srv._garmin = FakeGarmin()
        srv.VAPID_FILE.parent.mkdir(parents=True, exist_ok=True)
        srv.VAPID_FILE.write_text(json.dumps({"private": "priv", "public": "BPUBLICKEY"}))
        srv.PUSH_PREFS.unlink(missing_ok=True)
        self.c = TestClient(srv.app)
        self.h = {"X-Api-Key": "test-key"}
        self.sent = []
        self._orig = srv._send_push
        srv._send_push = lambda sub, notif: (self.sent.append(notif) or True)
        js = """
        import { generatePlan } from './app/js/engine/plan.js';
        const plan = generatePlan({ mode: 'fitness', fitnessGoal: 'regular', durationWeeks: 12, level: 'intermediate', weeklyKm: 5, longestRunKm: 3,
          days: [0, 2, 6], longRunDay: 6, otherSports: [] }, { today: '2026-11-14' });
        console.log(JSON.stringify({ plan, log: {} }));
        """
        out = subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True).stdout
        self.assertEqual(self.c.put("/backup", headers=self.h, content=out).status_code, 200)

    def tearDown(self):
        srv._send_push = self._orig

    def test_key_and_prefs(self):
        self.assertEqual(self.c.get("/push/key").status_code, 401)
        self.assertEqual(self.c.get("/push/key", headers=self.h).json()["key"], "BPUBLICKEY")
        self.assertFalse(self.c.get("/push/prefs", headers=self.h).json()["subscribed"])
        r = self.c.put("/push/prefs", headers=self.h, json={"subscription": {"endpoint": "https://p"}, "tz": "Europe/Paris",
                                                            "eve": {"enabled": True, "time": "20:00"}, "day": {"enabled": True, "time": "25:99"}})
        self.assertEqual(r.status_code, 200)
        got = self.c.get("/push/prefs", headers=self.h).json()
        self.assertTrue(got["subscribed"])
        self.assertEqual(got["day"]["time"], "07:00", "heure invalide corrigée au défaut")

    def test_tick_sends_once(self):
        self.c.put("/push/prefs", headers=self.h, json={"subscription": {"endpoint": "https://p"}, "tz": "Europe/Paris",
                                                        "eve": {"enabled": True, "time": "20:00"}, "day": {"enabled": True, "time": "07:00"}})
        from datetime import datetime, timezone
        n = srv._push_tick(datetime(2026, 11, 15, 19, 0, tzinfo=timezone.utc))  # dim 20h Paris
        self.assertEqual(n, 1)
        self.assertIn("Demain", self.sent[0]["title"])
        # Rejoué à 20h05 : plus rien
        self.assertEqual(srv._push_tick(datetime(2026, 11, 15, 19, 5, tzinfo=timezone.utc)), 0)

    def test_unsubscribe(self):
        self.c.put("/push/prefs", headers=self.h, json={"subscription": {"endpoint": "https://p"}})
        self.assertEqual(self.c.delete("/push/prefs", headers=self.h).json()["ok"], True)
        self.assertFalse(self.c.get("/push/prefs", headers=self.h).json()["subscribed"])
