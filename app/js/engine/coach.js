// Lecture des données réelles (Garmin) pour ajuster les allures, comme le ferait un coach.
//
// On n'analyse que les footings et sorties longues : ce sont les séances où l'effort
// doit rester facile, donc où l'écart entre allure et cœur est le plus parlant.
//  - Cœur trop haut sur la plupart des footings      → allures ralenties (tu cours trop vite pour ton niveau).
//  - Cœur bas ET allure au moins égale à la cible     → allures relevées (tu as progressé).
//  - Footings nettement plus rapides que la zone     → rappel : la lenteur est voulue.
// Seuils en % de la FC de réserve (Karvonen) si la FC de repos est connue, sinon en % de FC max.

import { addDays } from './dates.js';

const EASY_TYPES = ['easy', 'long'];
// Endurance fondamentale ≈ 59–74 % de la FC de réserve (≈ 65–79 % FC max).
export const LIMITS = { reserve: { low: 0.68, high: 0.78 }, max: { low: 0.76, high: 0.84 } };

function weekOf(plan, date) {
  return plan.weeks.find((w) => w.start <= date && date < addDays(w.start, 7));
}

/** Intensité cardiaque relative d'une course (0–1). */
export function hrIntensity(avgHr, hr) {
  if (!avgHr || !hr?.maxHr) return null;
  if (hr.restHr && hr.maxHr > hr.restHr) return { value: (avgHr - hr.restHr) / (hr.maxHr - hr.restHr), mode: 'reserve' };
  return { value: avgHr / hr.maxHr, mode: 'max' };
}

/**
 * Plafond de la zone facile (endurance fondamentale) en battements/min, d'après le profil cardiaque.
 * Réutilise LIMITS (haut de zone) : réserve de FC si la FC de repos est connue (Karvonen), sinon % FC max.
 * @returns { bpm, mode } ou null si la FC max est inconnue.
 */
export function easyHrCeiling(hr) {
  if (!hr?.maxHr) return null;
  if (hr.restHr && hr.maxHr > hr.restHr) {
    return { bpm: Math.round(hr.restHr + LIMITS.reserve.high * (hr.maxHr - hr.restHr)), mode: 'reserve' };
  }
  return { bpm: Math.round(LIMITS.max.high * hr.maxHr), mode: 'max' };
}

/**
 * Signaux des 14 derniers jours.
 * @param hr { maxHr, restHr } — profil cardiaque Garmin (peut être null : seule l'allure est alors utilisée).
 * @returns { n, deltaVdot, reasons, tooFast }
 */
export function dataSignals(plan, log, today, hr) {
  const from = addDays(today, -14);
  const runs = plan.weeks.flatMap((w) => w.sessions)
    .filter((s) => EASY_TYPES.includes(s.type) && s.date >= from && s.date < today)
    .map((s) => ({ s, e: log[s.id] }))
    .filter(({ e }) => e?.source === 'garmin' && e.paceSecPerKm);

  const out = { n: runs.length, deltaVdot: 0, reasons: [], tooFast: 0 };
  if (runs.length < 3) return out;

  let high = 0, lowAndFast = 0, withHr = 0;
  for (const { s, e } of runs) {
    const E = weekOf(plan, s.date)?.paces?.E;
    if (!E) continue;
    if (e.paceSecPerKm < E[0] - 5) out.tooFast++;
    const it = hrIntensity(e.avgHr, hr);
    if (!it) continue;
    withHr++;
    const lim = LIMITS[it.mode];
    if (it.value > lim.high) high++;
    else if (it.value <= lim.low && e.paceSecPerKm <= (E[0] + E[1]) / 2) lowAndFast++;
  }

  if (withHr >= 3 && high / withHr >= 0.5) {
    out.deltaVdot = -0.7;
    out.reasons.push(`Ton cœur est monté trop haut sur ${high} footing(s) sur ${withHr} : tes allures d'endurance sont ralenties pour rester vraiment en aisance.`);
  } else if (withHr >= 3 && lowAndFast / withHr >= 0.66) {
    out.deltaVdot = +0.5;
    out.reasons.push(`Footings tenus à bonne allure avec un cœur bas (${lowAndFast} sur ${withHr}) : tu as progressé, tes allures sont relevées.`);
  }
  if (out.tooFast >= Math.ceil(runs.length / 2) && out.deltaVdot <= 0) {
    out.reasons.push(`${out.tooFast} footing(s) sur ${runs.length} courus plus vite que la zone d'endurance : ralentis, la lenteur fait partie du plan.`);
  }
  return out;
}
