// Analyse d'une séance réalisée, puis ajustement de la suivante — le cœur du coaching.
//
// Quand la séance a été lancée depuis la montre, Garmin crée un tour par étape : on compare
// chaque répétition à son allure cible. Sinon, on se fie au ressenti.
//   réussie      → la progression continue normalement ;
//   trop dure    → la prochaine séance du même type reprend le même format (ou recule) ;
//   trop facile  → la prochaine séance du même type passe au format supérieur.

import { buildQuality } from './plan.js';
import { estimate } from './workouts.js';

export const QUALITY_TYPES = ['threshold', 'intervals', 'race-pace', 'fartlek', 'hills'];
const TOL = 5; // s/km de tolérance autour de la cible
const STEP = 0.25; // un cran de progression

const fmt = (sec) => `${Math.floor(sec / 60)}'${String(Math.round(sec % 60)).padStart(2, '0')}`;

/** Étapes dépliées (répétitions déroulées), dans l'ordre où la montre crée les tours. */
export function flattenSteps(steps) {
  const out = [];
  for (const st of steps) {
    if (st.kind === 'repeat') for (let i = 0; i < st.times; i++) out.push(...flattenSteps(st.steps));
    else out.push(st);
  }
  return out;
}

const lapPace = (lap) => (lap.distanceM > 0 ? lap.durationSec / (lap.distanceM / 1000) : null);

/**
 * @param session séance prévue ; entry : journal (feel, paceSecPerKm, avgHr…) ;
 * @param laps tours Garmin [{distanceM, durationSec, avgHr}] ou null ; weekPaces : allures de la semaine.
 * @returns { verdict: 'success'|'hard'|'easy'|'fast'|'unknown', details: string[], source: 'laps'|'feel'|'pace' }
 */
export function analyzeSession(session, entry, laps, weekPaces) {
  const details = [];
  const feel = entry?.feel;

  if (QUALITY_TYPES.includes(session.type) || session.type === 'test') {
    const expected = flattenSteps(session.steps);
    const aligned = Array.isArray(laps) && laps.length >= expected.length && laps.length <= expected.length + 1;
    const reps = aligned
      ? expected.map((st, i) => ({ st, lap: laps[i] })).filter((x) => x.st.kind === 'run' && x.st.pace && x.lap?.distanceM > 50)
      : [];
    if (reps.length >= 2) {
      let ok = 0, slow = 0, fast = 0;
      const paces = reps.map(({ st, lap }) => {
        const p = lapPace(lap);
        if (p > st.pace[1] + TOL) slow++; else if (p < st.pace[0] - TOL) fast++; else ok++;
        return p;
      });
      const n = reps.length;
      const fade = n >= 3 && paces.at(-1) - paces[0] > 8;
      const target = reps[0].st.pace;
      details.push(`${ok + fast}/${n} répétitions dans la cible ou plus vite (moyenne ${fmt(paces.reduce((a, b) => a + b, 0) / n)}/km pour ${fmt(target[0])}–${fmt(target[1])}).`);
      if (fade) details.push(`Allure en baisse sur la fin (${fmt(paces[0])} → ${fmt(paces.at(-1))}/km) : pars un peu plus prudemment.`);
      if (fast / n >= 0.5) details.push('Plusieurs répétitions plus rapides que la cible : ce n\'est pas plus efficace, et ça fatigue davantage.');
      let verdict;
      if (slow / n >= 0.4 || (fade && slow / n >= 0.2) || (feel === 'hard' && slow / n >= 0.2)) verdict = 'hard';
      else if ((ok + fast) / n >= 0.8 && fast / n >= 0.5 && feel === 'easy') verdict = 'easy';
      else if ((ok + fast) / n >= 0.6) verdict = 'success';
      else verdict = 'hard';
      return { verdict, details, source: 'laps' };
    }
    // Pas de tours exploitables (séance non lancée depuis la montre, côtes sans allure) : ressenti.
    details.push(aligned ? 'Séance à la sensation : analyse au ressenti.' : 'Séance non lancée depuis la montre (ou modifiée) : analyse au ressenti.');
    return { verdict: feel === 'hard' ? 'hard' : feel === 'easy' ? 'easy' : feel === 'ok' ? 'success' : 'unknown', details, source: 'feel' };
  }

  if (['easy', 'long'].includes(session.type)) {
    const E = weekPaces?.E;
    const pace = entry?.paceSecPerKm;
    let verdict = feel === 'hard' ? 'hard' : 'success';
    if (pace && E) {
      if (pace < E[0] - 10) {
        verdict = 'fast';
        details.push(`Footing à ${fmt(pace)}/km, plus vite que ta zone d'endurance (${fmt(E[0])}–${fmt(E[1])}) : ralentis, c'est en allant lentement que tu construis ton endurance.`);
      } else details.push(`Allure ${fmt(pace)}/km, dans ta zone d'endurance ✓`);
    }
    // Dérive cardiaque sur la sortie longue : cœur qui monte à allure constante = endurance à construire.
    if (session.type === 'long' && Array.isArray(laps) && laps.length >= 4 && laps.every((l) => l.avgHr && l.distanceM > 0)) {
      const half = Math.floor(laps.length / 2);
      const eff = (ls) => {
        const d = ls.reduce((a, l) => a + l.distanceM, 0), t = ls.reduce((a, l) => a + l.durationSec, 0);
        const hr = ls.reduce((a, l) => a + l.avgHr * l.durationSec, 0) / t;
        return (d / t) / hr; // vitesse par battement
      };
      const drift = 1 - eff(laps.slice(half)) / eff(laps.slice(0, half));
      if (drift > 0.05) details.push(`Dérive cardiaque de ${Math.round(drift * 100)} % sur la 2e moitié : ton endurance se construit, garde ces sorties lentes.`);
      else details.push(`Dérive cardiaque faible (${Math.max(0, Math.round(drift * 100))} %) : bonne endurance sur cette durée ✓`);
    }
    return { verdict, details, source: pace ? 'pace' : 'feel' };
  }
  return { verdict: 'unknown', details, source: 'feel' };
}

/**
 * Ajuste la prochaine séance du même type selon le verdict.
 * @returns { plan, note } — note : phrase affichée à l'utilisateur, ou null si rien ne change.
 */
export function applyVerdict(plan, log, sessionId, verdict) {
  const all = plan.weeks.flatMap((w) => w.sessions);
  const s = all.find((x) => x.id === sessionId);
  if (!s || !QUALITY_TYPES.includes(s.type) || s.level == null || !['hard', 'easy'].includes(verdict)) return { plan, note: null };
  const next = all.filter((x) => x.type === s.type && x.date > s.date && !log[x.id] && x.level != null)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!next) return { plan, note: null };
  const newLevel = verdict === 'hard' ? Math.min(next.level, Math.max(0, s.level - STEP / 2)) : Math.min(1, next.level + STEP);
  if (Math.abs(newLevel - next.level) < 0.01) return { plan, note: null };

  const copy = structuredClone(plan);
  const week = copy.weeks.find((w) => w.sessions.some((x) => x.id === next.id));
  const target = week.sessions.find((x) => x.id === next.id);
  const c = { paces: week.paces, racePaceRange: [plan.racePace - 2, plan.racePace + 2], raceDistance: plan.profile.raceDistance };
  const rebuilt = buildQuality(next.type, c, newLevel);
  const est = estimate(rebuilt.steps, week.paces);
  const before = target.title;
  Object.assign(target, rebuilt, { level: newLevel, km: est.km, min: est.min, adjustedFrom: before });
  week.volumeKm = Math.round(week.sessions.reduce((a, x) => a + x.km, 0) * 10) / 10;
  const note = before === rebuilt.title
    ? null
    : verdict === 'hard'
      ? `Séance trop dure : la prochaine (« ${before} ») devient « ${rebuilt.title} » pour consolider avant de progresser.`
      : `Séance facile : la prochaine (« ${before} ») passe à « ${rebuilt.title} ».`;
  return { plan: copy, note };
}
