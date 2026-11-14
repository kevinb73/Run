// Rapprochement des courses Garmin avec le plan (logique pure, testée).
//
// Pour chaque course Garmin pas encore traitée :
//  1. une séance prévue le même jour  → cochée « faite » avec les vraies données ;
//  2. sinon une séance prévue dans les 3 jours suivants et de distance proche → « faite en avance »
//     (la séance est déplacée au jour de la course) ;
//  3. sinon → course libre (comptée dans le volume).
// Une course libre intense rend la séance dure du lendemain « footing » (règle de sécurité).
//
// Autres activités (futsal, foot, et arbitrage enregistré sous n'importe quel sport) :
//  - jour de futsal/arbitrage prévu → coché « fait » automatiquement ;
//  - jour « course OU futsal » → la course est marquée remplacée ;
//  - sport imprévu intense → la séance dure du lendemain devient footing.

import { addDays, daysBetween } from './dates.js';
import { HARD_TYPES, downgradeToEasy } from './reschedule.js';

const isRun = (s) => !s.optional && s.type !== 'sport';
const SOCCER = /soccer|football|futsal/i;
export const isRunningActivity = (a) => !a.type || /running/i.test(a.type);
export const sportKindOf = (a) => (SOCCER.test(a.type ?? '') ? 'futsal' : 'other');

function sportEntry(a) {
  return { done: true, feel: undefined, durationSec: a.durationSec, avgHr: a.avgHr ?? undefined, garminId: a.id, source: 'garmin', at: a.date };
}

/** Le sport intense charge l'organisme : la séance dure du lendemain devient footing. */
function protectTomorrow(p, log, a, notices, label) {
  const intense = sportKindOf(a) === 'futsal' ? (a.durationSec ?? 0) >= 40 * 60 || (a.trainingEffect ?? 0) >= 3
    : (a.trainingEffect ?? 0) >= 3.5 || (a.anaerobicEffect ?? 0) >= 2;
  if (!intense) return p;
  const tomorrow = p.weeks.flatMap((w) => w.sessions).find((s) => s.date === addDays(a.date, 1) && HARD_TYPES.includes(s.type) && !log[s.id]);
  if (!tomorrow) return p;
  notices.push(`${label} du ${a.date} intense : « ${tomorrow.title} » du lendemain devient un footing.`);
  return downgradeToEasy(p, tomorrow.id);
}

function entryFrom(a, previous) {
  return {
    ...(previous ?? {}),
    done: true,
    actualKm: a.distanceKm,
    durationSec: a.durationSec,
    paceSecPerKm: a.paceSecPerKm,
    avgHr: a.avgHr ?? undefined,
    maxHr: a.maxHr ?? undefined,
    calories: a.calories ?? undefined,
    elevationGainM: a.elevationGainM ?? undefined,
    cadence: a.cadence ?? undefined,
    trainingEffect: a.trainingEffect ?? undefined,
    anaerobicEffect: a.anaerobicEffect ?? undefined,
    trainingLoad: a.trainingLoad ?? undefined,
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

  // Une activité antérieure au plan (ou à sa création) ne doit jamais cocher une séance du plan.
  // Une séance avancée avant le début officiel du plan (« Faire cette séance aujourd'hui ») ouvre le plan plus tôt.
  const firstSession = p.weeks.flatMap((w) => w.sessions).map((s) => s.date).sort()[0];
  const start = [p.weeks[0]?.start, firstSession].filter(Boolean).sort()[0];
  const planStart = [start, p.createdAt].filter(Boolean).sort().at(-1) ?? '';
  for (const a of [...activities].sort((x, y) => (x.start ?? '').localeCompare(y.start ?? ''))) {
    if (!a?.id || newKnown[a.id] || !a.date) continue;
    if (a.date < planStart) { newKnown[a.id] = 'pre-plan'; continue; }
    const pending = (s) => isRun(s) && !(newLog[s.id]?.done && newLog[s.id]?.source === 'garmin') && !newLog[s.id]?.replacedBy;
    const sportDay = (kind) => all().find((s) => s.type === 'sport' && s.date === a.date && (!kind || s.sport === kind) && !newLog[s.id]?.done);

    // Activité autre que la course (futsal, foot, autre sport)
    if (!isRunningActivity(a)) {
      const kind = sportKindOf(a);
      const planned = sportDay(kind === 'futsal' ? 'futsal' : 'referee') ?? sportDay();
      if (planned) {
        newLog[planned.id] = sportEntry(a);
        newKnown[a.id] = planned.id;
        notices.push(`${planned.title.replace(' (si tu y vas)', '')} du ${a.date} détecté sur ta montre ✓`);
      } else {
        const altRun = all().find((s) => s.date === a.date && s.alt && pending(s) && !newLog[s.id]);
        if (altRun) {
          newLog[altRun.id] = { ...sportEntry(a), replacedBy: altRun.alt };
          newKnown[a.id] = altRun.id;
          notices.push(`Futsal du ${a.date} détecté : « ${altRun.title} » comptée comme remplacée.`);
        } else {
          newKnown[a.id] = 'sport';
          notices.push(`Activité « ${a.name ?? a.type} » du ${a.date} prise en compte dans ta charge.`);
        }
      }
      p = protectTomorrow(p, newLog, a, notices, kind === 'futsal' ? 'Futsal' : 'Activité');
      continue;
    }

    // Course enregistrée un jour d'arbitrage sans course prévue : c'est l'arbitrage.
    const referee = sportDay('referee');
    if (referee && !all().some((s) => s.date === a.date && pending(s))) {
      newLog[referee.id] = sportEntry(a);
      newKnown[a.id] = referee.id;
      notices.push(`Arbitrage du ${a.date} détecté sur ta montre ✓`);
      p = protectTomorrow(p, newLog, { ...a, trainingEffect: Math.max(a.trainingEffect ?? 0, 3.5) }, notices, 'Arbitrage');
      continue;
    }

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
    p = protectTomorrow(p, newLog, a, notices, 'Course libre');
  }
  return { plan: p, log: newLog, known: newKnown, freeRuns, notices };
}
