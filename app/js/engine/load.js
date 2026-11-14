// Charge d'entraînement : course + futsal + arbitrage, comparée semaine (aiguë) / mois (chronique).
// Ratio aigu/chronique (Gabbett) : 0,8–1,3 zone optimale ; > 1,5 risque de blessure nettement accru.

import { addDays, daysBetween } from './dates.js';

/** Charge d'une activité : celle calculée par Garmin, sinon TRIMP de Banister, sinon durée × intensité moyenne. */
export function activityLoad(a, hr) {
  if (a.trainingLoad) return a.trainingLoad;
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
