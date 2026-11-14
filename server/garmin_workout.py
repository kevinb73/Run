"""Conversion d'une séance Run Coach (format de l'app) en séance structurée Garmin.

Format d'entrée (voir app/js/engine/workouts.js) :
  session = {id, date, title, description, min, steps: [...]}
  step    = {kind: warmup|run|recovery|cooldown, dur: {type: distance, m} | {type: time, s},
             zone: E|M|T|I|R|race|walk|None, pace: [rapide, lent] (s/km) | None, note}
  repeat  = {kind: repeat, times, steps: [...]}
"""

from __future__ import annotations

from typing import Any

from garminconnect.workout import (
    ConditionType,
    ExecutableStep,
    RepeatGroup,
    RunningWorkout,
    StepType,
    TargetType,
    WorkoutSegment,
    create_repeat_group,
)

RUNNING = {"sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1}

STEP_TYPES = {
    "warmup": (StepType.WARMUP, "warmup"),
    "cooldown": (StepType.COOLDOWN, "cooldown"),
    "run": (StepType.INTERVAL, "interval"),
    "recovery": (StepType.RECOVERY, "recovery"),
}

# Fourchette d'allure minimale sur la montre : en dessous, l'alerte sonne en permanence.
MIN_PACE_WINDOW_S = 20


def _pace_target(pace: list[float] | None) -> dict[str, Any]:
    if not pace:
        return {"targetType": {"workoutTargetTypeId": TargetType.NO_TARGET, "workoutTargetTypeKey": "no.target"}}
    fast, slow = float(pace[0]), float(pace[1])
    if slow - fast < MIN_PACE_WINDOW_S:
        mid = (fast + slow) / 2
        fast, slow = mid - MIN_PACE_WINDOW_S / 2, mid + MIN_PACE_WINDOW_S / 2
    # Garmin attend des vitesses (m/s) : valeur 1 = allure la plus lente.
    return {
        "targetType": {"workoutTargetTypeId": TargetType.PACE_ZONE, "workoutTargetTypeKey": "pace.zone"},
        "targetValueOne": round(1000 / slow, 4),
        "targetValueTwo": round(1000 / fast, 4),
    }


def _end_condition(dur: dict[str, Any]) -> dict[str, Any]:
    if dur["type"] == "distance":
        return {
            "endCondition": {"conditionTypeId": ConditionType.DISTANCE, "conditionTypeKey": "distance"},
            "endConditionValue": float(dur["m"]),
        }
    return {
        "endCondition": {"conditionTypeId": ConditionType.TIME, "conditionTypeKey": "time"},
        "endConditionValue": float(dur["s"]),
    }


class _Counter:
    def __init__(self) -> None:
        self.order = 0
        self.child = 0

    def next(self) -> int:
        self.order += 1
        return self.order


def _convert(steps: list[dict[str, Any]], c: _Counter, child_id: int | None) -> list[ExecutableStep | RepeatGroup]:
    out: list[ExecutableStep | RepeatGroup] = []
    for st in steps:
        if st["kind"] == "repeat":
            order = c.next()
            c.child += 1
            cid = c.child
            group = create_repeat_group(int(st["times"]), _convert(st["steps"], c, cid), order)
            group.childStepId = cid
            out.append(group)
            continue
        type_id, type_key = STEP_TYPES.get(st["kind"], (StepType.OTHER, "other"))
        # Échauffement / retour au calme / marche : pas d'alerte d'allure (inutile et agaçant).
        # Accélérations (R) : à la sensation, pas de cible. Endurance (E) : seule l'alerte « trop vite » compte,
        # on élargit donc la borne lente (+90 s/km) pour ne jamais pousser à accélérer un footing.
        with_target = st["kind"] in ("run",) and st.get("zone") not in (None, "walk", "R")
        pace = st.get("pace")
        if with_target and pace and st.get("zone") == "E":
            pace = [pace[0], pace[1] + 90]
        step = ExecutableStep(
            stepOrder=c.next(),
            stepType={"stepTypeId": type_id, "stepTypeKey": type_key},
            childStepId=child_id,
            description=(st.get("note") or None),
            **_end_condition(st["dur"]),
            **_pace_target(pace if with_target else None),
        )
        out.append(step)
    return out


def session_to_workout(session: dict[str, Any]) -> dict[str, Any]:
    """Construit le JSON à envoyer à Garmin Connect pour une séance."""
    c = _Counter()
    steps = _convert(session["steps"], c, None)
    name = f"RC {session['date'][5:]} {session['title']}"
    workout = RunningWorkout(
        workoutName=name[:60],
        estimatedDurationInSecs=int(session.get("min", 30)) * 60,
        description=(session.get("description") or "")[:500] or None,
        workoutSegments=[WorkoutSegment(segmentOrder=1, sportType=RUNNING, workoutSteps=steps)],
    )
    return workout.to_dict()
