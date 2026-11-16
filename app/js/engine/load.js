// Charge d'entraînement : course + futsal + arbitrage, comparée semaine (aiguë) / mois (chronique).
// Ratio aigu/chronique (Gabbett) : 0,8–1,3 zone optimale ; > 1,5 risque de blessure nettement accru.

import { addDays, daysBetween } from './dates.js';

const RPE_SCALE = 0.45; // 60 min de futsal « Correct » (RPE 6) ≈ 160, de l'ordre de la charge Garmin d'un match
export const FEEL_RPE = { easy: 4, ok: 6, hard: 8 };

/** Sports notés à la main avec une durée (pas d'activité Garmin) → pseudo-activités pour la charge. */
export function manualActivities(plan, log) {
  return plan.weeks.flatMap((w) => w.sessions)
    .map((s) => ({ s, e: log[s.id] }))
    .filter(({ e }) => e?.done && e.sportMin > 0 && e.source !== 'garmin')
    .map(({ s, e }) => ({ id: `manual-${s.id}`, date: s.date, durationSec: e.sportMin * 60, rpe: FEEL_RPE[e.feel] ?? 6 }));
}

/** Charge d'une activité : celle calculée par Garmin, sinon TRIMP de Banister, sinon durée × intensité moyenne. */
export function activityLoad(a, hr) {
  if (a.trainingLoad) return a.trainingLoad;
  // Sport noté à la main (sans montre) : méthode RPE de Foster (durée × effort perçu), ramenée à l'échelle Garmin.
  if (a.rpe) return Math.round(((a.durationSec ?? 0) / 60) * a.rpe * RPE_SCALE);
  const min = (a.durationSec ?? 0) / 60;
  if (a.avgHr && hr?.maxHr && hr?.restHr && hr.maxHr > hr.restHr) {
    const x = Math.min(1, Math.max(0, (a.avgHr - hr.restHr) / (hr.maxHr - hr.restHr)));
    return Math.round(min * x * 0.64 * Math.exp(1.92 * x));
  }
  return Math.round(min * 0.8);
}

/**
 * @param acts activités Garmin [{date, durationSec, avgHr, trainingLoad}]
 * @returns { acute, chronic, ratio, zone: 'low'|'optimal'|'elevated'|'high'|null, enoughData }
 */
export function loadStatus(acts, today, hr) {
  const inRange = (a, days) => a.date > addDays(today, -days) && a.date <= today;
  const sum = (days) => acts.filter((a) => inRange(a, days)).reduce((s, a) => s + activityLoad(a, hr), 0);
  const acute = sum(7);
  const chronic = sum(28) / 4;
  const first = acts.map((a) => a.date).sort()[0];
  const enoughData = !!first && daysBetween(first, today) >= 14 && chronic > 0;
  if (!enoughData) return { acute, chronic: Math.round(chronic), ratio: null, zone: null, enoughData };
  const ratio = acute / chronic;
  const zone = ratio < 0.8 ? 'low' : ratio <= 1.3 ? 'optimal' : ratio <= 1.5 ? 'elevated' : 'high';
  return { acute, chronic: Math.round(chronic), ratio: Math.round(ratio * 100) / 100, zone, enoughData };
}

export const LOAD_LABELS = {
  low: 'en baisse',
  optimal: 'zone optimale',
  elevated: 'élevée',
  high: 'trop élevée',
};

/**
 * Évolution de la « forme » (charge chronique) et de la fatigue (charge aiguë) dans le temps.
 * Un point par semaine, sur les N dernières semaines, seulement là où il y a assez d'historique.
 * @returns [{ date, fitness, fatigue, ratio, zone }]
 */
export function loadTrend(acts, today, hr, { weeks = 12 } = {}) {
  const pts = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const d = addDays(today, -w * 7);
    const st = loadStatus(acts.filter((a) => a.date <= d), d, hr);
    if (st.enoughData) pts.push({ date: d, fitness: st.chronic, fatigue: st.acute, ratio: st.ratio, zone: st.zone });
  }
  return pts;
}
