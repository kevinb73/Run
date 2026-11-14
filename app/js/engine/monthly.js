// Bilan mensuel : tout ce qui a été fait dans le mois (course, futsal, arbitrage, renfo), avec calories,
// comparé au mois précédent, et quelques phrases de coach.
//
// Sources : activités Garmin (state.acts, la référence quand la montre était portée) + séances notées à la main
// (sans montre). Une activité Garmin rattachée à une séance (state.known) n'est comptée qu'une fois.

import { todayISO } from './dates.js';

const SOCCER = /soccer|football|futsal/i;
const STRENGTH = /strength|fitness_equipment/i;
const RUN = /running/i;
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
// Estimation sans montre (kcal/min, adulte ~75 kg) : ordre de grandeur, affiché « ≈ ».
const KCAL_PER_MIN = { run: 11, futsal: 10, referee: 9, strength: 5, other: 7 };

export const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
export const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
export const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };

const empty = () => ({ n: 0, min: 0, kcal: 0, kcalEstimated: false });

/**
 * @param st { plan, log, acts, known }
 * @param month 'YYYY-MM'
 */
export function monthlyReport(st, month, today = todayISO()) {
  const inMonth = (d) => d?.slice(0, 7) === month;
  const sessions = st.plan ? st.plan.weeks.flatMap((w) => w.sessions) : [];
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  const r = { month, run: { ...empty(), km: 0, longestKm: 0, bestPace: null, hrSum: 0, hrN: 0 }, futsal: empty(), referee: empty(), strength: empty(), other: empty() };
  const add = (cat, min, kcal) => {
    const c = r[cat]; c.n++; c.min += min;
    if (kcal) c.kcal += kcal; else { c.kcal += Math.round(min * KCAL_PER_MIN[cat]); c.kcalEstimated = true; }
  };

  // 1. Activités Garmin du mois
  const garminIds = new Set();
  for (const a of Object.values(st.acts ?? {})) {
    if (!inMonth(a.date)) continue;
    garminIds.add(String(a.id));
    const linked = byId[st.known?.[a.id]];
    const min = (a.durationSec ?? 0) / 60;
    const cat = linked?.type === 'sport' ? linked.sport
      : linked?.type === 'strength' || STRENGTH.test(a.type ?? '') ? 'strength'
        : SOCCER.test(a.type ?? '') ? 'futsal'
          : RUN.test(a.type ?? '') || !a.type ? 'run' : 'other';
    add(cat, min, a.calories);
    if (cat === 'run') {
      const km = a.distanceKm ?? 0;
      r.run.km += km;
      r.run.longestKm = Math.max(r.run.longestKm, km);
      if (km >= 1.5 && a.paceSecPerKm && (!r.run.bestPace || a.paceSecPerKm < r.run.bestPace)) r.run.bestPace = a.paceSecPerKm;
      if (a.avgHr) { r.run.hrSum += a.avgHr; r.run.hrN++; }
    }
  }

  // 2. Séances notées à la main (sans activité Garmin)
  for (const s of sessions) {
    const e = st.log?.[s.id];
    if (!e?.done || !inMonth(s.date) || (e.garminId != null && garminIds.has(String(e.garminId)))) continue;
    if (e.garminId != null) continue; // activité Garmin plus ancienne que la rétention : ignorée plutôt que mal comptée
    if (s.type === 'strength') { add('strength', s.min ?? 15, null); continue; }
    if (s.type === 'sport' || e.replacedBy) {
      const kind = s.type === 'sport' ? s.sport : e.replacedBy;
      add(kind === 'referee' ? 'referee' : 'futsal', e.sportMin ?? (kind === 'referee' ? 90 : 60), null);
      continue;
    }
    const km = e.actualKm ?? s.km ?? 0;
    const min = e.durationSec ? e.durationSec / 60 : s.min ?? 0;
    add('run', min, e.calories);
    r.run.km += km;
    r.run.longestKm = Math.max(r.run.longestKm, km);
  }

  // 3. Régularité : courses prévues (passées) vs faites ; renfo fait vs proposé
  const past = sessions.filter((s) => inMonth(s.date) && s.date <= today);
  const plannedRuns = past.filter((s) => !s.optional && s.type !== 'strength');
  r.regularity = { planned: plannedRuns.length, done: plannedRuns.filter((s) => st.log?.[s.id]?.done).length };
  r.strengthPlanned = past.filter((s) => s.type === 'strength').length;

  r.run.km = Math.round(r.run.km * 10) / 10;
  r.run.avgHr = r.run.hrN ? Math.round(r.run.hrSum / r.run.hrN) : null;
  delete r.run.hrSum; delete r.run.hrN;
  const cats = ['run', 'futsal', 'referee', 'strength', 'other'];
  r.total = {
    sessions: cats.reduce((a, c) => a + r[c].n, 0),
    min: Math.round(cats.reduce((a, c) => a + r[c].min, 0)),
    kcal: Math.round(cats.reduce((a, c) => a + r[c].kcal, 0)),
    kcalEstimated: cats.some((c) => r[c].kcalEstimated),
  };
  for (const c of cats) r[c].min = Math.round(r[c].min);
  return r;
}

/** Variation en % (null si pas de base de comparaison). */
const delta = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);

/** Bilan + comparaison au mois précédent + phrases de coach. */
export function monthlySummary(st, month, today = todayISO()) {
  const cur = monthlyReport(st, month, today);
  const prev = monthlyReport(st, prevMonth(month), today);
  const d = { km: delta(cur.run.km, prev.run.km), min: delta(cur.total.min, prev.total.min), kcal: delta(cur.total.kcal, prev.total.kcal), sessions: delta(cur.total.sessions, prev.total.sessions) };
  const lines = [];
  const reg = cur.regularity;
  if (reg.planned) {
    const pct = Math.round((reg.done / reg.planned) * 100);
    lines.push(pct >= 90 ? `Régularité exemplaire : ${reg.done} séances sur ${reg.planned} (${pct} %). C'est le facteur n° 1 de progression.`
      : pct >= 70 ? `${reg.done} séances sur ${reg.planned} (${pct} %) : solide. Vise 1 séance de plus le mois prochain.`
        : `${reg.done} séances sur ${reg.planned} (${pct} %). Plutôt que d'en faire plus, sécurise 2 créneaux fixes par semaine.`);
  }
  if (d.km != null && cur.run.km > 0) lines.push(d.km > 15 ? `Volume de course en hausse de ${d.km} % : bien, mais au-delà de +20 % par mois le risque de blessure augmente, la progression doit rester douce.`
    : d.km >= -10 ? `Volume de course stable (${d.km >= 0 ? '+' : ''}${d.km} %) : c'est exactement ce qui construit l'endurance.`
      : `Volume de course en baisse (${d.km} %) : normal après une coupure ; on remonte progressivement.`);
  if (cur.strength.n) lines.push(`${cur.strength.n} séance${cur.strength.n > 1 ? 's' : ''} de renforcement${cur.strengthPlanned ? ` sur ${cur.strengthPlanned} proposées` : ''} : tes chevilles et tes genoux te remercient.`);
  else if (cur.strengthPlanned) lines.push(`Aucun renforcement ce mois-ci sur ${cur.strengthPlanned} proposés : c'est ta meilleure assurance contre les blessures, même 1 par semaine compte.`);
  if (cur.total.kcal >= 1000) lines.push(`${cur.total.kcal.toLocaleString('fr-FR')} kcal dépensées à l'entraînement, soit l'équivalent énergétique d'environ ${(cur.total.kcal / 7700).toFixed(1).replace('.', ',')} kg de graisse (ordre de grandeur : la balance dépend surtout de l'alimentation).`);
  return { cur, prev, delta: d, lines };
}

/** Mois couverts par les données (du plus ancien au mois en cours). */
export function availableMonths(st, today = todayISO()) {
  const dates = [...Object.values(st.acts ?? {}).map((a) => a.date), ...(st.plan ? [st.plan.weeks[0].start] : [])].filter(Boolean).sort();
  const first = (dates[0] ?? today).slice(0, 7), last = today.slice(0, 7);
  const out = [];
  for (let m = first; m <= last && out.length < 36; m = nextMonth(m)) out.push(m);
  return out;
}

