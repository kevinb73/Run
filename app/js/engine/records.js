// Records personnels, jalons et série de semaines régulières : le bloc « motivation ».
//
// Sources des courses : activités Garmin (state.acts) + courses notées à la main (sans montre).
// Les records sont honnêtes : une allure « record » n'est retenue que sur une course d'au moins 2 km,
// et le meilleur 5 km n'est estimé (allure moyenne × 5) que sur une sortie d'au moins 5 km.

import { addDays, todayISO } from './dates.js';

const RUN = /running/i;
const WALK_PACE = 630; // au-delà de 10'30/km en moyenne, c'est surtout de la marche

/** Toutes les courses (une entrée par course réelle). */
export function allRuns(st) {
  const sessions = st.plan ? st.plan.weeks.flatMap((w) => w.sessions) : [];
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  const out = [];
  const garminIds = new Set();
  for (const a of Object.values(st.acts ?? {})) {
    const linked = byId[st.known?.[a.id]];
    if (linked?.type === 'sport' || linked?.type === 'strength' || (a.type && !RUN.test(a.type))) continue; // arbitrage, futsal, renfo
    garminIds.add(String(a.id));
    const km = a.distanceKm ?? 0, sec = a.durationSec ?? 0;
    if (km <= 0 || sec <= 0) continue;
    out.push({ date: a.date, km, sec, pace: a.paceSecPerKm ?? sec / km, sessionId: linked?.id ?? null });
  }
  for (const s of sessions) {
    const e = st.log?.[s.id];
    if (!e?.done || e.replacedBy || e.garminId != null || ['sport', 'strength', 'race', 'test'].includes(s.type)) continue;
    const km = e.actualKm ?? s.km ?? 0, sec = e.durationSec ?? (s.min ?? 0) * 60;
    if (km > 0 && sec > 0) out.push({ date: s.date, km, sec, pace: sec / km, sessionId: s.id, manual: true });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const RECORDS = {
  longestKm: { label: 'Plus longue sortie', fmt: 'km', pick: (r) => r.km, better: (a, b) => a > b, min: (r) => r.km >= 1 },
  longestTime: { label: 'Plus longue durée de course', fmt: 'time', pick: (r) => r.sec, better: (a, b) => a > b, min: (r) => r.pace <= WALK_PACE },
  bestPace: { label: 'Meilleure allure moyenne (≥ 2 km)', fmt: 'pace', pick: (r) => r.pace, better: (a, b) => a < b, min: (r) => r.km >= 2 },
  best5k: { label: 'Meilleur 5 km (estimé, sortie ≥ 5 km)', fmt: 'time', pick: (r) => r.pace * 5, better: (a, b) => a < b, min: (r) => r.km >= 5 },
};

export const MILESTONES = [
  { key: 'run20', label: '20 min de course', test: (r) => r.sec >= 1200 && r.pace <= WALK_PACE },
  { key: 'run30', label: '30 min de course', test: (r) => r.sec >= 1800 && r.pace <= WALK_PACE },
  { key: 'km5', label: 'Premier 5 km', test: (r) => r.km >= 5 },
  { key: 'run45', label: '45 min de course', test: (r) => r.sec >= 2700 && r.pace <= WALK_PACE },
  { key: 'km10', label: 'Premier 10 km', test: (r) => r.km >= 10 },
  { key: 'run60', label: '1 h de course', test: (r) => r.sec >= 3600 && r.pace <= WALK_PACE },
];
export const TOTAL_MILESTONES = [50, 100, 250, 500, 1000];

/**
 * Semaines régulières consécutives : toutes les courses prévues faites (ou remplacées par le sport).
 * La semaine en cours compte dès qu'elle est complète ; une semaine sans course prévue ne casse pas la série.
 */
export function streak(st, today = todayISO()) {
  if (!st.plan) return { current: 0, best: 0 };
  let current = 0, best = 0, run = 0;
  for (const w of st.plan.weeks) {
    const end = addDays(w.start, 6);
    const runs = w.sessions.filter((s) => !s.optional && s.type !== 'strength');
    if (!runs.length) continue;
    const ok = runs.every((s) => st.log?.[s.id]?.done);
    if (end >= today && !ok) break; // semaine en cours pas encore complète : ne casse pas la série
    if (ok) { run++; best = Math.max(best, run); } else run = 0;
    if (end >= today) break;
  }
  current = run;
  return { current, best };
}

/** Records, jalons, cumul et série. Chaque record garde sa date et la valeur précédente. */
export function computeRecords(st, today = todayISO()) {
  const runs = allRuns(st);
  const records = {};
  for (const [key, def] of Object.entries(RECORDS)) {
    let bestR = null, prev = null;
    for (const r of runs) {
      if (!def.min(r)) continue;
      const v = def.pick(r);
      if (!bestR || def.better(v, bestR.value)) { prev = bestR?.value ?? null; bestR = { key, label: def.label, fmt: def.fmt, value: v, date: r.date, prev }; }
    }
    if (bestR) records[key] = bestR;
  }
  const milestones = MILESTONES.map((m) => ({ ...m, date: runs.find(m.test)?.date ?? null }));
  let cum = 0;
  const totals = TOTAL_MILESTONES.map((km) => {
    cum = 0;
    const hit = runs.find((r) => (cum += r.km) >= km);
    return { key: `total${km}`, label: `${km} km au total`, date: hit?.date ?? null };
  });
  const totalKm = Math.round(runs.reduce((a, r) => a + r.km, 0) * 10) / 10;
  return { records, milestones: [...milestones, ...totals], totalKm, streak: streak(st, today), nRuns: runs.length };
}

/**
 * Nouveautés à célébrer : records battus (pas le tout premier) et jalons atteints depuis `since`,
 * non encore vus (seen = { clé: true }).
 */
export function newAchievements(st, since, seen = {}, today = todayISO()) {
  const { records, milestones } = computeRecords(st, today);
  const out = [];
  for (const r of Object.values(records)) {
    const id = `${r.key}:${r.date}`;
    if (r.date >= since && r.prev != null && !seen[id]) out.push({ id, kind: 'record', ...r });
  }
  for (const m of milestones) {
    const id = `${m.key}:${m.date}`;
    if (m.date && m.date >= since && !seen[id]) out.push({ id, kind: 'milestone', label: m.label, date: m.date });
  }
  return out;
}
