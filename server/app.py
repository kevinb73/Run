"""Serveur de synchronisation Run Coach ↔ Garmin Connect.

- Connexion au compte Garmin (une seule fois, double authentification gérée) ; seuls les
  jetons sont conservés, jamais le mot de passe.
- Envoi d'une séance structurée dans le calendrier Garmin (elle apparaît sur la montre).
- Lecture des courses terminées, pour que l'app coche et adapte le plan.

Toutes les routes (sauf /health) exigent l'en-tête X-Api-Key.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import threading
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from garminconnect import Garmin
from pydantic import BaseModel, Field

from garmin_workout import session_to_workout

DATA_DIR = Path(os.environ.get("RUNCOACH_DATA", "/var/lib/runcoach"))
TOKENS = DATA_DIR / "garmin"
STATE_FILE = DATA_DIR / "state.json"
BACKUPS = DATA_DIR / "backups"
MAX_BACKUP_BYTES = 2_000_000
KEEP_BACKUPS = 20
API_KEY = os.environ.get("RUNCOACH_API_KEY", "")
ALLOWED_ORIGINS = os.environ.get("RUNCOACH_ORIGINS", "https://kevinb73.github.io").split(",")

log = logging.getLogger("runcoach")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI(title="Run Coach sync", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["X-Api-Key", "Content-Type"],
    max_age=86400,
)

_lock = threading.RLock()
_garmin: Garmin | None = None
_pending: dict[str, Any] = {}  # connexion en attente du code de double authentification
_failed_logins: list[float] = []


# ---------------------------------------------------------------- utilitaires

def require_key(x_api_key: str = Header(default="")) -> None:
    if not API_KEY or not hmac.compare_digest(x_api_key.encode(), API_KEY.encode()):
        raise HTTPException(status_code=401, detail="Clé d'accès invalide.")


def load_state() -> dict[str, Any]:
    try:
        return json.loads(STATE_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {"workouts": {}}


def save_state(state: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    tmp.replace(STATE_FILE)


def garmin() -> Garmin:
    """Client Garmin connecté, restauré depuis les jetons si besoin."""
    global _garmin
    with _lock:
        if _garmin is None:
            if not (TOKENS / "garmin_tokens.json").exists():
                raise HTTPException(status_code=409, detail="Compte Garmin non connecté.")
            g = Garmin()
            try:
                g.login(tokenstore=str(TOKENS))
            except Exception as exc:  # jetons expirés ou révoqués
                log.warning("Restauration des jetons Garmin impossible : %s", type(exc).__name__)
                raise HTTPException(status_code=409, detail="Connexion Garmin expirée : reconnecte ton compte.") from exc
            _garmin = g
        return _garmin


def garmin_call(fn, *args, **kwargs):
    """Appel Garmin protégé : transforme les erreurs en messages compréhensibles."""
    try:
        with _lock:
            return fn(*args, **kwargs)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Erreur Garmin")
        raise HTTPException(status_code=502, detail=f"Garmin a refusé la requête ({type(exc).__name__}).") from exc


# ---------------------------------------------------------------- santé & connexion

@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "runcoach-sync"}


@app.get("/garmin/status", dependencies=[Depends(require_key)])
def status() -> dict[str, Any]:
    try:
        g = garmin()
    except HTTPException as exc:
        return {"connected": False, "reason": exc.detail}
    return {"connected": True, "name": g.get_full_name()}


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=1, max_length=200)


class MfaIn(BaseModel):
    code: str = Field(min_length=4, max_length=12)


@app.post("/garmin/login", dependencies=[Depends(require_key)])
def login(body: LoginIn) -> dict[str, Any]:
    global _garmin
    now = time.time()
    _failed_logins[:] = [t for t in _failed_logins if now - t < 900]
    if len(_failed_logins) >= 5:
        raise HTTPException(status_code=429, detail="Trop d'essais : réessaie dans 15 minutes.")
    with _lock:
        g = Garmin(body.email, body.password, return_on_mfa=True)
        try:
            result, client_state = g.login()
        except Exception as exc:
            _failed_logins.append(now)
            log.warning("Échec de connexion Garmin : %s", type(exc).__name__)
            raise HTTPException(status_code=400, detail="Connexion refusée par Garmin : vérifie e-mail et mot de passe.") from exc
        if result == "needs_mfa":
            _pending.clear()
            _pending.update({"g": g, "state": client_state, "at": now})
            return {"connected": False, "mfa": True}
        g.client.dump(str(TOKENS))
        _garmin = g
    return {"connected": True, "name": g.get_full_name()}


@app.post("/garmin/mfa", dependencies=[Depends(require_key)])
def mfa(body: MfaIn) -> dict[str, Any]:
    global _garmin
    with _lock:
        if not _pending or time.time() - _pending["at"] > 600:
            _pending.clear()
            raise HTTPException(status_code=400, detail="Code expiré : recommence la connexion.")
        g = _pending["g"]
        try:
            g.resume_login(_pending["state"], body.code.strip())
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Code refusé par Garmin.") from exc
        _pending.clear()
        g.client.dump(str(TOKENS))
        _garmin = g
    return {"connected": True, "name": g.get_full_name()}


@app.post("/garmin/logout", dependencies=[Depends(require_key)])
def logout() -> dict[str, Any]:
    global _garmin
    with _lock:
        _garmin = None
        for f in TOKENS.glob("*.json"):
            f.unlink()
    return {"connected": False}


# ---------------------------------------------------------------- séances

class SessionIn(BaseModel):
    id: str = Field(max_length=64)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    title: str = Field(max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    min: int | None = None
    steps: list[dict[str, Any]]


def _remove(state: dict[str, Any], session_id: str) -> None:
    old = state["workouts"].pop(session_id, None)
    if old:
        try:
            garmin().delete_workout(old["workoutId"])
        except Exception:
            log.info("Ancienne séance %s déjà absente chez Garmin", old.get("workoutId"))


@app.post("/workouts", dependencies=[Depends(require_key)])
def push_workout(session: SessionIn) -> dict[str, Any]:
    """Envoie (ou remplace) la séance dans le calendrier Garmin à sa date."""
    payload = session_to_workout(session.model_dump())
    g = garmin()
    with _lock:
        state = load_state()
        _remove(state, session.id)
        created = garmin_call(g.upload_workout, payload)
        workout_id = created["workoutId"]
        garmin_call(g.schedule_workout, workout_id, session.date)
        state["workouts"][session.id] = {"workoutId": workout_id, "date": session.date}
        save_state(state)
    return {"sessionId": session.id, "workoutId": workout_id, "date": session.date}


@app.delete("/workouts/{session_id}", dependencies=[Depends(require_key)])
def delete_workout(session_id: str) -> dict[str, Any]:
    with _lock:
        state = load_state()
        _remove(state, session_id)
        save_state(state)
    return {"deleted": session_id}


# ---------------------------------------------------------------- activités

def _summary(a: dict[str, Any]) -> dict[str, Any]:
    dist = a.get("distance") or 0
    dur = a.get("movingDuration") or a.get("duration") or 0
    return {
        "id": a.get("activityId"),
        "name": a.get("activityName"),
        "start": a.get("startTimeLocal"),
        "date": (a.get("startTimeLocal") or "")[:10],
        "type": (a.get("activityType") or {}).get("typeKey"),
        "distanceKm": round(dist / 1000, 2),
        "durationSec": round(dur),
        "paceSecPerKm": round(dur / (dist / 1000)) if dist else None,
        "avgHr": a.get("averageHR"),
        "maxHr": a.get("maxHR"),
        "trainingEffect": a.get("aerobicTrainingEffect"),
        "anaerobicEffect": a.get("anaerobicTrainingEffect"),
    }


@app.get("/activities", dependencies=[Depends(require_key)])
def activities(start: str | None = None, end: str | None = None) -> dict[str, Any]:
    """Toutes les activités (course, futsal, autres) : l'app fait le tri."""
    end_d = date.fromisoformat(end) if end else date.today()
    start_d = date.fromisoformat(start) if start else end_d - timedelta(days=14)
    if (end_d - start_d).days > 120:
        raise HTTPException(status_code=400, detail="Période limitée à 120 jours.")
    g = garmin()
    raw = garmin_call(g.get_activities_by_date, start_d.isoformat(), end_d.isoformat())
    acts = [_summary(a) for a in raw]
    return {"activities": sorted(acts, key=lambda x: x["start"] or "")}


@app.get("/activities/{activity_id}/laps", dependencies=[Depends(require_key)])
def laps(activity_id: int) -> dict[str, Any]:
    """Tours d'une activité (une séance structurée crée un tour par étape) : sert à isoler un test."""
    g = garmin()
    raw = garmin_call(g.get_activity_splits, str(activity_id)) or {}
    out = []
    for lap in raw.get("lapDTOs") or []:
        out.append({
            "distanceM": round(lap.get("distance") or 0),
            "durationSec": round(lap.get("duration") or lap.get("elapsedDuration") or 0),
            "avgHr": lap.get("averageHR"),
        })
    return {"laps": out}


@app.get("/garmin/profile", dependencies=[Depends(require_key)])
def hr_profile() -> dict[str, Any]:
    """FC max, FC repos et seuil tels que réglés dans Garmin (zones de course à pied de préférence)."""
    g = garmin()
    try:
        zones = garmin_call(g.get_heart_rate_zones_v2) or []
    except Exception:  # profil indisponible : l'app se contente alors de l'allure
        zones = []
    if isinstance(zones, dict):
        zones = zones.get("heartRateZones") or zones.get("zones") or [zones]
    by_sport = {(z.get("sport") or "").upper(): z for z in zones if isinstance(z, dict)}
    z = by_sport.get("RUNNING") or by_sport.get("DEFAULT") or (zones[0] if zones else {})
    return {
        "maxHr": z.get("maxHeartRateUsed"),
        "restHr": z.get("restingHeartRateUsed"),
        "lthr": z.get("lactateThresholdHeartRateUsed"),
    }


# ---------------------------------------------------------------- sauvegarde du plan

@app.put("/backup", dependencies=[Depends(require_key)])
async def put_backup(request: Request) -> dict[str, Any]:
    """Sauvegarde le plan et l'historique de l'app (on garde les 20 dernières versions)."""
    body = await request.body()
    if len(body) > MAX_BACKUP_BYTES:
        raise HTTPException(status_code=413, detail="Sauvegarde trop volumineuse.")
    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Sauvegarde illisible.") from exc
    if not isinstance(data, dict) or "plan" not in data:
        raise HTTPException(status_code=400, detail="Sauvegarde incomplète.")
    BACKUPS.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + f"{int(time.time() * 1000) % 1000:03d}"
    (BACKUPS / f"backup-{stamp}.json").write_bytes(body)
    for old in sorted(BACKUPS.glob("backup-*.json"))[:-KEEP_BACKUPS]:
        old.unlink()
    return {"saved": stamp}


@app.get("/backup", dependencies=[Depends(require_key)])
def get_backup() -> dict[str, Any]:
    files = sorted(BACKUPS.glob("backup-*.json")) if BACKUPS.exists() else []
    if not files:
        raise HTTPException(status_code=404, detail="Aucune sauvegarde sur le serveur.")
    return {"saved": files[-1].stem.removeprefix("backup-"), "data": json.loads(files[-1].read_text())}
