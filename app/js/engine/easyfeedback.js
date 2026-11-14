// Après un footing (ou une sortie longue) : ajuste le footing suivant s'il tombe dans les 3 jours.
//
// Règle volontairement asymétrique (prudence) :
//   ressenti « dur » ou cœur au-dessus de la zone facile → footing suivant −20 % et consigne « encore plus lent » ;
//   sinon → rien : la progression se fait déjà semaine après semaine, pas séance après séance.

import { addDays } from './dates.js';
import { estimate } from './workouts.js';
import { hrIntensity, LIMITS } from './coach.js';

const EASY = ['easy', 'long'];

export function applyEasyFeedback(plan, log, sessionId, hr) {
  const all = plan.weeks.flatMap((w) => w.sessions);
  const s = all.find((x) => x.id === sessionId);
  const e = log[sessionId];
  if (!s || !e || !EASY.includes(s.type)) return { plan, note: null };

  const hi = hrIntensity(e.avgHr, hr);
  const hrHigh = hi && hi.value > LIMITS[hi.mode].high;
  const feltHard = e.feel === 'hard';
  if (!hrHigh && !feltHard) return { plan, note: null };

  const next = all.filter((x) => EASY.includes(x.type) && x.date > s.date && x.date <= addDays(s.date, 3) && !log[x.id] && !x.eased)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!next) return { plan, note: null };

  const copy = structuredClone(plan);
  const week = copy.weeks.find((w) => w.sessions.some((x) => x.id === next.id));
  const target = week.sessions.find((x) => x.id === next.id);
  // Durée totale −20 % : les accélérations sont remplacées par du footing (on récupère), la partie continue est ajustée.
  const kept = target.steps.filter((st) => st.kind !== 'repeat');
  const isDist = (st) => st.dur?.type === 'distance';
  const distMin = estimate(kept.filter(isDist), week.paces).min;
  const otherMin = estimate(kept.filter((st) => !isDist(st)), week.paces).min;
  const factor = distMin > 0 ? Math.max(0.3, Math.min(1.5, (target.min * 0.8 - otherMin) / distMin)) : 1;
  const steps = kept.map((st) => (isDist(st) ? { ...st, dur: { ...st.dur, m: Math.max(1000, Math.round(st.dur.m * factor / 100) * 100) } } : st));
  const est = estimate(steps, week.paces);
  const beforeMin = Math.round(target.min);
  const beforeTitle = target.title;
  Object.assign(target, {
    steps, km: est.km, min: est.min, eased: true,
    title: target.type === 'long' ? 'Sortie longue (allégée)' : 'Footing (allégé)',
    description: `${target.description} Allégée après ta dernière séance (sans accélérations) : pars encore plus lentement.`,
  });
  week.volumeKm = Math.round(week.sessions.reduce((a, x) => a + (x.km ?? 0), 0) * 10) / 10;

  const why = feltHard && hrHigh ? `séance ressentie dure et cœur élevé (${e.avgHr} bpm)`
    : feltHard ? 'séance ressentie dure' : `cœur au-dessus de la zone facile (${e.avgHr} bpm)`;
  const note = `${why[0].toUpperCase()}${why.slice(1)} : « ${beforeTitle} » passe de ${beforeMin} à ${Math.round(est.min)} min, sans accélérations et encore plus lentement.`;
  return { plan: copy, note, nextId: target.id };
}
