"""Rappels de séance (web push) : « veille au soir » et « jour même ».

Logique volontairement isolée et pure (aucune I/O) pour être testable :
`notifications_due(prefs, state, now_utc)` dit quelles notifications envoyer maintenant et met à jour `last_sent`.
L'envoi réel (pywebpush) et le stockage des préférences restent dans app.py.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]


def default_prefs() -> dict[str, Any]:
    return {
        "subscription": None,
        "tz": "Europe/Paris",
        "eve": {"enabled": True, "time": "20:00"},   # la veille au soir
        "day": {"enabled": True, "time": "07:00"},   # le jour même
        "last_sent": {},
    }


def _tz(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("Europe/Paris")


def _sessions(state: dict) -> list[dict]:
    return [s for w in (state.get("plan") or {}).get("weeks", []) for s in w.get("sessions", [])]


def _hm(minutes: float) -> str:
    m = round(minutes)
    return f"{m // 60} h {m % 60:02d}" if m >= 60 else f"{m} min"


def training_on(state: dict, day: str) -> dict | None:
    """Ce qu'il y a à faire un jour donné (course / renfo), ou None si repos / sport facultatif seul.

    Les séances de sport (futsal, arbitrage) sont facultatives : on ne harcèle pas l'utilisateur pour elles.
    """
    log = state.get("log") or {}
    runs, strength = [], []
    for s in _sessions(state):
        if s.get("date") != day:
            continue
        e = log.get(s["id"]) or {}
        if e.get("done") or e.get("skipped"):
            continue
        if s.get("type") == "strength":
            strength.append(s)
        elif not s.get("optional") and s.get("type") != "sport":
            runs.append(s)
    if not runs and not strength:
        return None
    parts = []
    main = runs[0] if runs else None
    if main:
        detail = f"{str(main.get('km', '')).replace('.', ',')} km · ~{_hm(main.get('min') or 0)}"
        parts.append(f"{main.get('title', 'Course')} ({detail})")
    if strength:
        parts.append("renforcement ~" + _hm(strength[0].get("min") or 15))
    return {"title": main.get("title") if main else "Renforcement", "summary": " + ".join(parts)}


def _build(kind: str, state: dict, target_day: str) -> dict | None:
    t = training_on(state, target_day)
    if not t:
        return None
    jour = JOURS[date.fromisoformat(target_day).weekday()]
    if kind == "eve":
        return {"kind": "eve", "day": target_day, "title": f"Demain : {t['title']}", "body": t["summary"]}
    return {"kind": "day", "day": target_day, "title": f"Aujourd'hui : {t['title']}", "body": t["summary"]}


def notifications_due(prefs: dict[str, Any], state: dict, now_utc: datetime) -> tuple[list[dict], dict[str, str]]:
    """@returns (notifications à envoyer, nouveau last_sent). Pur : n'envoie rien, ne stocke rien."""
    if not prefs or not prefs.get("subscription") or not state.get("plan"):
        return [], dict(prefs.get("last_sent") or {})
    tz = _tz(prefs.get("tz") or "Europe/Paris")
    now = now_utc.astimezone(tz)
    today_local = now.date().isoformat()
    last = dict(prefs.get("last_sent") or {})
    out = []
    for kind, target in (("day", today_local), ("eve", (now.date() + timedelta(days=1)).isoformat())):
        cfg = prefs.get(kind) or {}
        if not cfg.get("enabled"):
            continue
        hh, _, mm = (cfg.get("time") or "").partition(":")
        try:
            due_at = now.replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
        except ValueError:
            continue
        # On envoie une fois, à partir de l'heure prévue (fenêtre : jusqu'à 2 h après, pour rattraper un serveur endormi).
        if last.get(kind) == today_local or now < due_at or now > due_at + timedelta(hours=2):
            continue
        notif = _build(kind, state, target)
        if notif:
            out.append(notif)
            last[kind] = today_local
    return out, last
