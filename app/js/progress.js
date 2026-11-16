// Écran « Progrès » : petits graphiques SVG faits main (aucune dépendance).
// Règles : une courbe par graphique (le titre la nomme, pas de légende), trait 2 px, points ≥ 8 px,
// grille discrète, valeur affichée au toucher. Couleurs = jetons CSS (thème clair/sombre).

import { predictTime } from './engine/vdot.js';
import { addDays } from './engine/dates.js';
import { loadStatus, loadTrend, manualActivities, LOAD_LABELS } from './engine/load.js';
import { esc, duration, pace, dateShort } from './format.js';

const W = 340, H = 150, PAD = { l: 44, r: 12, t: 12, b: 24 };

function scale(d0, d1, r0, r1) {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

const dayNum = (iso) => Date.parse(iso + 'T00:00:00Z') / 86400000;

/**
 * Courbe à une série.
 * @param pts [{ date, y, tip }] ; fmt : formatage de l'axe ; invert : valeur basse en haut (temps).
 */
export function lineChart(pts, { fmt = String, invert = false, empty = 'Pas encore de données.' } = {}) {
  if (pts.length < 2) return `<p class="muted chart-empty">${esc(empty)}</p>`;
  const xs = pts.map((p) => dayNum(p.date)), ys = pts.map((p) => p.y);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const padY = (y1 - y0) * 0.15 || Math.abs(y0) * 0.05 || 1;
  y0 -= padY; y1 += padY;
  const sx = scale(Math.min(...xs), Math.max(...xs), PAD.l, W - PAD.r);
  const sy = invert ? scale(y0, y1, PAD.t, H - PAD.b) : scale(y0, y1, H - PAD.b, PAD.t);
  const ticks = [0, 0.5, 1].map((f) => y0 + (y1 - y0) * f);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(xs[i]).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">
    ${ticks.map((v) => `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${sy(v)}" y2="${sy(v)}"/>
      <text class="axis" x="${PAD.l - 6}" y="${sy(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`).join('')}
    <text class="axis" x="${PAD.l}" y="${H - 6}">${esc(dateShort(pts[0].date))}</text>
    <text class="axis" x="${W - PAD.r}" y="${H - 6}" text-anchor="end">${esc(dateShort(pts.at(-1).date))}</text>
    <path class="line" d="${path}"/>
    ${pts.map((p, i) => `<g class="pt" data-tip="${esc(p.tip)}"><circle class="hit" cx="${sx(xs[i])}" cy="${sy(p.y)}" r="14"/>
      <circle class="dot" cx="${sx(xs[i])}" cy="${sy(p.y)}" r="4"/></g>`).join('')}
  </svg>`;
}

/** Barres hebdomadaires : réalisé (plein) devant le prévu (fantôme). */
export function volumeChart(rows) {
  if (!rows.length) return '<p class="muted chart-empty">Pas encore de semaine terminée.</p>';
  const max = Math.max(...rows.map((r) => Math.max(r.planned, r.done)), 1);
  const bw = (W - PAD.l - PAD.r) / rows.length;
  const sy = scale(0, max * 1.1, H - PAD.b, PAD.t);
  const ticks = [0, max / 2, max];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">
    ${ticks.map((v) => `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${sy(v)}" y2="${sy(v)}"/>
      <text class="axis" x="${PAD.l - 6}" y="${sy(v) + 4}" text-anchor="end">${Math.round(v)}</text>`).join('')}
    ${rows.map((r, i) => {
      const w = Math.max(3, Math.min(18, bw * 0.55)), x = PAD.l + i * bw + (bw - w) / 2;
      const tip = `Semaine ${r.n} : ${r.done.toFixed(1)} km faits / ${r.planned.toFixed(1)} prévus`;
      return `<g class="pt" data-tip="${esc(tip)}"><rect class="hit-rect" x="${PAD.l + i * bw}" y="${PAD.t}" width="${bw}" height="${H - PAD.b - PAD.t}"/>
        <rect class="bar-ghost" x="${x}" y="${sy(r.planned)}" width="${w}" height="${Math.max(0, sy(0) - sy(r.planned))}" rx="3"/>
        <rect class="bar" x="${x}" y="${sy(r.done)}" width="${w}" height="${Math.max(0, sy(0) - sy(r.done))}" rx="3"/></g>`;
    }).join('')}
    <text class="axis" x="${PAD.l}" y="${H - 6}">S${rows[0].n}</text>
    <text class="axis" x="${W - PAD.r}" y="${H - 6}" text-anchor="end">S${rows.at(-1).n}</text>
  </svg>`;
}

/** Données de l'écran Progrès à partir de l'état de l'app. */
export function progressData(state, today) {
  const plan = state.plan;
  const sessions = plan.weeks.flatMap((w) => w.sessions);
  const dist = plan.profile.raceDistance || 5000;
  const distLabel = dist === 5000 ? '5 km' : dist === 10000 ? '10 km' : dist === 21097 ? 'semi' : 'marathon';

  // 1. Niveau : prédiction sur la distance du plan à chaque recalibrage
  const levels = [{ date: plan.createdAt, v: plan.vdotStart }, ...(plan.adjustments ?? []).map((a) => ({ date: a.date, v: a.vdotAfter }))]
    .filter((x) => x.v);
  const level = levels.map((x) => {
    const t = predictTime(x.v, dist);
    return { date: x.date, y: t, tip: `${dateShort(x.date)} : ${duration(t)} sur ${distLabel}` };
  });

  // 2. Efficacité : mètres parcourus par battement de cœur sur les footings (monte = progrès)
  const eff = Object.values(state.acts ?? {})
    .filter((a) => /running/.test(a.type ?? '') && a.avgHr && a.paceSecPerKm && a.durationSec >= 15 * 60)
    .filter((a) => {
      const s = sessions.find((x) => x.date === a.date && ['easy', 'long'].includes(x.type));
      return !!s;
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((a) => {
      const mPerBeat = (1000 / a.paceSecPerKm) * 60 / a.avgHr;
      return { date: a.date, y: mPerBeat, tip: `${dateShort(a.date)} : ${mPerBeat.toFixed(2).replace('.', ',')} m/battement (${pace(a.paceSecPerKm)}/km à ${a.avgHr} bpm)` };
    });

  // 3. Volume par semaine terminée ou en cours
  const free = state.freeRuns ?? [];
  const volume = plan.weeks.filter((w) => w.start <= today).map((w) => {
    const end = addDays(w.start, 7);
    const done = w.sessions.filter((s) => state.log[s.id]?.done && !s.optional && !state.log[s.id]?.replacedBy)
      .reduce((a, s) => a + (state.log[s.id].actualKm ?? s.km), 0)
      + free.filter((r) => r.date >= w.start && r.date < end).reduce((a, r) => a + r.distanceKm, 0);
    return { n: w.index + 1, planned: w.volumeKm, done };
  });

  // 4. Chiffres clés
  const tests = sessions.filter((s) => s.type === 'test' && state.log[s.id]?.testDistanceM)
    .map((s) => ({ date: s.date, vma: state.log[s.id].testDistanceM / 100 }));
  const past = sessions.filter((s) => s.date < today && !s.optional && s.type !== 'race');
  const doneCount = past.filter((s) => state.log[s.id]?.done).length;
  const totalKm = volume.reduce((a, r) => a + r.done, 0);

  // 5. Forme (charge chronique) dans le temps + fraîcheur actuelle (ratio aigu/chronique)
  const acts = [...Object.values(state.acts ?? {}), ...manualActivities(plan, state.log)];
  const form = loadTrend(acts, today, state.hr).map((p) => ({
    date: p.date, y: p.fitness,
    tip: `${dateShort(p.date)} : forme ${p.fitness}${p.zone ? ` · fraîcheur ${LOAD_LABELS[p.zone]}` : ''}`,
  }));
  const loadNow = loadStatus(acts, today, state.hr);

  return { level, eff, volume, tests, distLabel, form, loadNow, regularity: past.length ? doneCount / past.length : null, doneCount, totalKm };
}
