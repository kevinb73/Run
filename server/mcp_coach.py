"""Connecteur ChatGPT (protocole MCP, transport HTTP « streamable », réponses JSON) — LECTURE SEULE.

ChatGPT n'envoie rien tout seul : il appelle ces outils uniquement quand l'utilisateur pose une question
dans une conversation où le connecteur est activé. Les données viennent de la dernière sauvegarde de l'app
(plan, journal des séances, activités Garmin) et, pour la forme du jour, de Garmin en direct.

Implémentation volontairement minimale (aucune dépendance) : initialize, ping, tools/list, tools/call.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import date, timedelta
from typing import Any, Callable

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
INSTRUCTIONS = (
    "Tu es le coach course à pied de l'utilisateur (francophone). Les outils lisent son plan Run Coach "
    "(remise en forme, futsal et arbitrage en parallèle), ses séances avec ressenti, cardio et calories, sa charge "
    "et sa forme Garmin. Réponds en français, de façon structurée et chiffrée, sans complaisance. Priorités : "
    "régularité, prévention des blessures (chevilles, genoux), progression douce. Tu ne peux rien modifier : "
    "si un changement est utile, dis à l'utilisateur quoi faire dans l'app (Pas dispo, Mes jours, Pause, Signaler une douleur)."
)


def mcp_token(api_key: str) -> str:
    """Secret de l'adresse du connecteur, dérivé de la clé d'accès (rien à configurer sur le serveur)."""
    return hmac.new(api_key.encode(), b"run-coach-mcp", hashlib.sha256).hexdigest()[:32]


# ---------------------------------------------------------------- lecture des données

def _sessions(st: dict) -> list[dict]:
    return [s for w in (st.get("plan") or {}).get("weeks", []) for s in w.get("sessions", [])]


def _week_of(st: dict, d: str) -> dict | None:
    for w in (st.get("plan") or {}).get("weeks", []):
        start = date.fromisoformat(w["start"])
        if start <= date.fromisoformat(d) < start + timedelta(days=7):
            return w
    return None


JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
SPORTS = {"futsal": "futsal", "referee": "arbitrage"}


def _jour(d: str) -> str:
    return JOURS[date.fromisoformat(d).weekday()]


def _pace(sec: float | None) -> str | None:
    if not sec:
        return None
    sec = round(sec)
    return f"{sec // 60}'{sec % 60:02d}/km"


def _session_view(s: dict, e: dict | None) -> dict:
    e = e or {}
    out = {"date": s["date"], "jour": _jour(s["date"]), "titre": s.get("title"), "type": s.get("type"), "prevu_km": s.get("km"), "prevu_min": s.get("min")}
    if s.get("type") == "sport":
        out["sport"] = SPORTS.get(s.get("sport"), s.get("sport"))
    if s.get("alt"):
        out["ou_sport"] = SPORTS.get(s["alt"], s["alt"])
    if e.get("done"):
        out["statut"] = "remplacée par " + e["replacedBy"] if e.get("replacedBy") else "faite"
    elif e.get("skipped"):
        out["statut"] = "sautée"
    else:
        out["statut"] = "à faire"
    for k_in, k_out in (("feel", "ressenti"), ("actualKm", "km"), ("avgHr", "fc_moy"), ("maxHr", "fc_max"), ("calories", "calories"),
                        ("sportMin", "duree_sport_min"), ("note", "note")):
        if e.get(k_in) is not None:
            out[k_out] = e[k_in]
    if e.get("durationSec"):
        out["duree_min"] = round(e["durationSec"] / 60, 1)
    if e.get("paceSecPerKm"):
        out["allure"] = _pace(e["paceSecPerKm"])
    elif e.get("actualKm") and e.get("durationSec"):
        out["allure"] = _pace(e["durationSec"] / e["actualKm"])
    if e.get("pain"):
        out["douleur"] = e["pain"]
    a = e.get("analysis") or {}
    if a:
        out["analyse"] = {"verdict": a.get("verdict"), "details": a.get("details"), "ajustement": a.get("note")}
    return out


def tool_profil_et_plan(st: dict, args: dict, today: str) -> dict:
    plan = st.get("plan") or {}
    prof = plan.get("profile") or {}
    w = _week_of(st, today) or next((x for x in plan.get("weeks", []) if x["start"] > today), None)
    log = st.get("log") or {}
    upcoming = [s for s in _sessions(st) if s["date"] >= today and not s.get("optional") and not (log.get(s["id"]) or {}).get("done")][:4]
    paces = (w or {}).get("paces") or {}
    return {
        "objectif": plan.get("raceLabel"), "but": plan.get("goalText"), "mode": plan.get("mode"),
        "semaines": len(plan.get("weeks", [])), "debut": (plan.get("weeks") or [{}])[0].get("start"),
        "jours_course": [JOURS[d] for d in sorted(prof.get("days") or [])],
        "jour_sortie_longue": JOURS[prof["longRunDay"]] if prof.get("longRunDay") is not None else None,
        "sports_si_il_y_va": [{"jour": JOURS[x["day"]], "sport": SPORTS.get(x["kind"], x["kind"])} for x in sorted(prof.get("otherSports") or [], key=lambda x: x["day"])],
        "note_jours": "Un jour qui est à la fois jour de course et de sport = « course OU sport » (l'un ou l'autre, pas les deux).",
        "renforcement": prof.get("strength") is not False,
        "semaine_en_cours": w and {"numero": w["index"] + 1, "debut": w["start"], "phase": w.get("phase"), "allegee": w.get("recovery"),
                                   "volume_km": w.get("volumeKm"), "seances": [_session_view(s, log.get(s["id"])) for s in w["sessions"]]},
        "allures": {k: [_pace(v[0]), _pace(v[1])] for k, v in paces.items() if isinstance(v, list)},
        "prochaines_seances": [_session_view(s, None) for s in upcoming],
        "en_pause": st.get("pause"),
    }


def tool_seances_recentes(st: dict, args: dict, today: str) -> dict:
    days = max(1, min(90, int(args.get("jours") or 14)))
    since = (date.fromisoformat(today) - timedelta(days=days)).isoformat()
    log = st.get("log") or {}
    seances = [_session_view(s, log.get(s["id"])) for s in _sessions(st)
               if since <= s["date"] <= today and (log.get(s["id"]) or not s.get("optional"))]
    linked = {str(k) for k in (st.get("known") or {})}
    autres = [{"date": a.get("date"), "jour": _jour(a["date"]) if a.get("date") else None, "type": a.get("type"), "nom": a.get("name"), "km": a.get("distanceKm"),
               "duree_min": round((a.get("durationSec") or 0) / 60, 1), "fc_moy": a.get("avgHr"), "calories": a.get("calories"),
               "charge": a.get("trainingLoad"), "rattachee_au_plan": str(a.get("id")) in linked and (st.get("known") or {}).get(str(a.get("id"))) not in ("pre-plan", "sport", "free")}
              for a in (st.get("acts") or {}).values() if since <= (a.get("date") or "") <= today]
    return {"periode": [since, today], "seances_du_plan": seances, "activites_garmin": sorted(autres, key=lambda x: x["date"])}


def tool_bilan_mensuel(st: dict, args: dict, today: str) -> dict:
    month = str(args.get("mois") or today[:7])[:7]
    log = st.get("log") or {}
    acts = [a for a in (st.get("acts") or {}).values() if (a.get("date") or "").startswith(month)]
    garmin_ids = {str(a.get("id")) for a in acts}
    manuel = [_session_view(s, log[s["id"]]) for s in _sessions(st)
              if s["date"].startswith(month) and (log.get(s["id"]) or {}).get("done") and str((log[s["id"]]).get("garminId")) not in garmin_ids]
    run = [a for a in acts if "running" in (a.get("type") or "running")]
    planned = [s for s in _sessions(st) if s["date"].startswith(month) and s["date"] <= today and not s.get("optional") and s.get("type") != "strength"]
    return {
        "mois": month,
        "activites_garmin": len(acts), "km_course_garmin": round(sum(a.get("distanceKm") or 0 for a in run), 1),
        "minutes_garmin": round(sum((a.get("durationSec") or 0) for a in acts) / 60),
        "calories_garmin": sum(a.get("calories") or 0 for a in acts),
        "seances_notees_sans_montre": manuel,
        "regularite": {"prevues": len(planned), "faites": sum(1 for s in planned if (log.get(s["id"]) or {}).get("done"))},
        "detail_garmin": [{"date": a.get("date"), "type": a.get("type"), "km": a.get("distanceKm"), "min": round((a.get("durationSec") or 0) / 60),
                           "calories": a.get("calories"), "fc_moy": a.get("avgHr")} for a in sorted(acts, key=lambda x: x.get("date") or "")],
        "note": "Les arbitrages enregistrés en « course à pied » sur la montre apparaissent comme course : croiser avec le plan (jour d'arbitrage).",
    }


def tool_forme_et_charge(st: dict, args: dict, today: str, readiness: Callable[[str], dict] | None = None) -> dict:
    t = date.fromisoformat(today)
    acts = list((st.get("acts") or {}).values())

    def load(a):
        if a.get("trainingLoad"):
            return a["trainingLoad"]
        return round((a.get("durationSec") or 0) / 60 * 0.8)

    def total(days):
        lo = (t - timedelta(days=days)).isoformat()
        return sum(load(a) for a in acts if lo < (a.get("date") or "") <= today)

    acute, chronic = total(7), total(28) / 4
    out = {"charge_7j": acute, "charge_moyenne_hebdo_28j": round(chronic),
           "ratio_aigu_chronique": round(acute / chronic, 2) if chronic else None,
           "reperes": "0,8–1,3 zone optimale ; > 1,5 risque de blessure nettement accru (ratio fiable après ~2 semaines de données)",
           "profil_cardiaque": st.get("hr")}
    if readiness:
        try:
            out["forme_du_jour"] = readiness(today)
        except Exception:  # Garmin indisponible : on répond sans
            out["forme_du_jour"] = None
    return out


def tool_douleurs_et_ajustements(st: dict, args: dict, today: str) -> dict:
    log = st.get("log") or {}
    pains = [{"date": s["date"], "seance": s.get("title"), "douleur": log[s["id"]]["pain"]}
             for s in _sessions(st) if (log.get(s["id"]) or {}).get("pain")]
    adj = ((st.get("plan") or {}).get("adjustments") or [])[-10:]
    return {"douleurs_signalees": pains[-15:], "ajustements_du_plan": adj, "pause": st.get("pause")}


TOOLS: dict[str, tuple[Callable, dict]] = {
    "profil_et_plan": (tool_profil_et_plan, {
        "title": "Profil et plan en cours",
        "description": "Objectif, jours de course et de sport, semaine en cours (séances et statut), allures d'entraînement, prochaines séances.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}),
    "seances_recentes": (tool_seances_recentes, {
        "title": "Séances récentes",
        "description": "Séances du plan sur les N derniers jours (statut, ressenti, km, durée, allure, cardio, calories, douleur, analyse) et activités Garmin (futsal, arbitrage, courses libres).",
        "inputSchema": {"type": "object", "properties": {"jours": {"type": "integer", "minimum": 1, "maximum": 90, "description": "Nombre de jours (14 par défaut)"}}, "additionalProperties": False}}),
    "bilan_mensuel": (tool_bilan_mensuel, {
        "title": "Bilan d'un mois",
        "description": "Totaux du mois (km, minutes, calories), régularité, détail des activités Garmin et séances notées sans montre.",
        "inputSchema": {"type": "object", "properties": {"mois": {"type": "string", "pattern": "^\\d{4}-\\d{2}$", "description": "Mois AAAA-MM (mois en cours par défaut)"}}, "additionalProperties": False}}),
    "forme_et_charge": (tool_forme_et_charge, {
        "title": "Forme et charge d'entraînement",
        "description": "Charge 7 jours vs moyenne 28 jours (ratio aigu/chronique), profil cardiaque, forme du jour Garmin (disponibilité, VFC, sommeil).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}),
    "douleurs_et_ajustements": (tool_douleurs_et_ajustements, {
        "title": "Douleurs et ajustements",
        "description": "Douleurs signalées (zone, intensité) et derniers ajustements automatiques du plan (raisons).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}),
}


def _tool_list() -> list[dict]:
    return [{"name": name, **meta, "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False, "title": meta["title"]}}
            for name, (_, meta) in TOOLS.items()]


def handle(message: Any, load_backup: Callable[[], tuple[str | None, dict | None]], readiness: Callable[[str], dict] | None,
           version: str, today: str | None = None) -> Any:
    """Traite un message (ou un lot) JSON-RPC. Renvoie None pour une notification (réponse HTTP 202)."""
    if isinstance(message, list):
        out = [r for r in (handle(m, load_backup, readiness, version, today) for m in message) if r is not None]
        return out or None
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Requête invalide"}}
    mid, method, params = message.get("id"), message.get("method"), message.get("params") or {}
    if mid is None:  # notification (ex. notifications/initialized)
        return None

    def ok(result):
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    if method == "initialize":
        asked = params.get("protocolVersion")
        return ok({"protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                   "capabilities": {"tools": {"listChanged": False}},
                   "serverInfo": {"name": "run-coach", "title": "Run Coach", "version": version},
                   "instructions": INSTRUCTIONS})
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": _tool_list()})
    if method == "tools/call":
        name = params.get("name")
        if name not in TOOLS:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"Outil inconnu : {name}"}}
        saved, st = load_backup()
        if st is None:
            return ok({"content": [{"type": "text", "text": "Aucune sauvegarde de l'app sur le serveur : ouvre Run Coach une fois (connecté au serveur)."}], "isError": True})
        d = today or date.today().isoformat()
        fn = TOOLS[name][0]
        try:
            data = fn(st, params.get("arguments") or {}, d, readiness) if name == "forme_et_charge" else fn(st, params.get("arguments") or {}, d)
        except Exception as exc:  # données inattendues : erreur lisible plutôt qu'un plantage
            return ok({"content": [{"type": "text", "text": f"Erreur de lecture des données : {exc}"}], "isError": True})
        data = {"donnees_au": saved, "aujourd_hui": d, **data}
        return ok({"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}], "structuredContent": data, "isError": False})
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Méthode non prise en charge : {method}"}}
