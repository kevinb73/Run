"""Faux serveur Run Coach pour les tests de bout en bout : vraie API FastAPI, Garmin simulé.

Points de contrôle réservés aux tests :
  POST /__test/activities  (corps : liste d'activités Garmin brutes) → ce que renverra Garmin
  GET  /__test/calls       → séances envoyées / supprimées
"""
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("RUNCOACH_DATA", tempfile.mkdtemp())
os.environ["RUNCOACH_API_KEY"] = "k"
sys.path.insert(0, os.path.join(ROOT, "server"))

import uvicorn  # noqa: E402
from fastapi import Body  # noqa: E402

import app as srv  # noqa: E402
import test_server  # noqa: E402

fake = test_server.FakeGarmin()
state = {"activities": [], "fail": None}
fake.get_activities_by_date = lambda start, end, *a, **k: list(state["activities"])
_upload = fake.upload_workout


def upload(payload):
    if state["fail"] and state["fail"] in (payload.get("workoutName") or ""):
        raise RuntimeError("refus simulé")
    return _upload(payload)


fake.upload_workout = upload
srv._garmin = fake


@srv.app.post("/__test/activities")
def set_activities(acts: list = Body(...)):
    state["activities"] = acts
    return {"ok": True}


@srv.app.post("/__test/fail")
def set_fail(body: dict = Body(...)):
    state["fail"] = body.get("pattern")
    return {"ok": True}


@srv.app.get("/__test/calls")
def calls():
    return {"uploaded": [w.get("workoutName") for w in fake.uploaded], "deleted": fake.deleted, "scheduled": fake.scheduled}


if __name__ == "__main__":
    uvicorn.run(srv.app, host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")
