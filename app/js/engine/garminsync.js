// Rapprochement des courses Garmin avec le plan (logique pure, testée).
//
// Pour chaque course Garmin pas encore traitée :
//  1. une séance prévue le même jour  → cochée « faite » avec les vraies données ;
//  2. sinon une séance prévue dans les 3 jours suivants et de distance proche → « faite en avance »
//     (la séance est déplacée au jour de la course) ;
//  3. sinon → course libre (comptée dans le volume).
// Une course libre intense rend la séance dure du lendemain « footing » (règle de sécurité).

import { addDays, daysBetween } from './dates.js';
import { HARD_TYPES, downgradeToEasy } from './reschedule.js';

const isRun = (s) => !s.optional && s.type !== 'sport';

function entryFrom(a, previous) {
  return {
    ...(previous ?? {}),
    done: true,
    actualKm: a.distanceKm,
    durationSec: a.durationSec,
    paceSecPerKm: a.paceSecPerKm,
    avgHr: a.avgHr ?? undefined,
    garminId: a.id,
    source: 'garmin',
    at: a.date,
  };
}

/**
 * @param plan      plan courant
 * @param log       journal des séances { [sessionId]: entry }
 * @param activities résumés renvoyés par le serveur (/activities)
 * @param known     { [activityId]: true|sessionId|'free' } activités déjà traitées
 * @returns { plan, log, known, freeRuns, notices }
 */
export function applyActivities(plan, log, activities, known) {
  let p = plan;
  const newLog = { ...log };
  const newKnown = { ...known };
  const freeRuns = [];
  const notices = [];
  const all = () => p.weeks.flatMap((w) => w.sessions);

  for (const a of [...activities].sort((x, y) => (x.start ?? '').localeCompare(y.start ?? ''))) {
    if (!a?.id || newKnown[a.id] || !a.date) continue;
    const pending = (s) => isRun(s) && !(newLog[s.id]?.done && newLog[s.id]?.source === 'garmin') && !newLog[s.id]?.replacedBy;

    // 1. Séance du jour
    const same = all().find((s) => s.date === a.date && pending(s) && !newLog[s.id]?.done)
      ?? all().find((s) => s.date === a.date && pending(s));
    if (same) {
      newLog[same.id] = entryFrom(a, newLog[same.id]);
      newKnown[a.id] = same.id;
      notices.push(`Course du ${a.date} associée à « ${same.title} ».`);
      continue;
    }

    // 2. Séance faite en avance (dans les 3 jours suivants, distance comparable)
    const ahead = all()
      .filter((s) => pending(s) && !newLog[s.id] && s.type !== 'race' && s.date > a.date && daysBetween(a.date, s.date) <= 3)
      .find((s) => a.distanceKm >= s.km * 0.6 && a.distanceKm <= s.km * 1.5);
    if (ahead) {
      p = structuredClone(p);
      const moved = all().find((s) => s.id === ahead.id);
      moved.movedFrom ??= moved.date;
      moved.date = a.date;
      for (const w of p.weeks) w.sessions.sort((x, y) => x.date.localeCompare(y.date));
      newLog[ahead.id] = entryFrom(a);
      newKnown[a.id] = ahead.id;
      notices.push(`Course du ${a.date} : « ${ahead.title} » faite en avance (prévue le ${ahead.date}).`);
      continue;
    }

    // 3. Course libre
    newKnown[a.id] = 'free';
    freeRuns.push(a);
    notices.push(`Course libre du ${a.date} (${a.distanceKm} km) ajoutée à ton volume.`);
    const intense = (a.trainingEffect ?? 0) >= 3.5 || (a.anaerobicEffect ?? 0) >= 2;
    if (intense) {
      const tomorrow = all().find((s) => s.date === addDays(a.date, 1) && HARD_TYPES.includes(s.type) && !newLog[s.id]);
      if (tomorrow) {
        p = downgradeToEasy(p, tomorrow.id);
        notices.push(`Ta course libre du ${a.date} était intense : « ${tomorrow.title} » du lendemain devient un footing.`);
      }
    }
  }
  return { plan: p, log: newLog, known: newKnown, freeRuns, notices };
}
