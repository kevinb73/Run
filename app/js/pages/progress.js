import { lineChart, volumeChart as weeklyVolumeChart, progressData } from '../progress.js';
import { esc, duration, dateShort, pace } from '../format.js';
import { monthlySummary, availableMonths, monthLabel } from '../engine/monthly.js';
import { LOAD_LABELS } from '../engine/load.js';
import { state, today, view } from '../core.js';
import { recordsCard } from '../achievements.js';

export function renderProgress() {
  const t = today();
  const d = progressData(state, t);
  const lastVma = d.tests.at(-1);
  const effDelta = d.eff.length >= 4
    ? (d.eff.slice(-3).reduce((a, x) => a + x.y, 0) / 3) / (d.eff.slice(0, 3).reduce((a, x) => a + x.y, 0) / 3) - 1 : null;
  view.innerHTML = `<h1>Progrès</h1>
    ${monthlyCard(t)}
    ${recordsCard(t)}
    <div class="tiles">
      <div class="tile"><span class="tile-value">${d.regularity == null ? '—' : Math.round(d.regularity * 100) + ' %'}</span><span class="tile-label">séances faites</span></div>
      <div class="tile"><span class="tile-value">${Math.round(d.totalKm)}</span><span class="tile-label">km courus</span></div>
      <div class="tile"><span class="tile-value">${lastVma ? lastVma.vma.toFixed(1).replace('.', ',') : '—'}</span><span class="tile-label">VMA (km/h)</span></div>
    </div>
    <section class="card"><h2>Prédiction ${esc(d.distLabel)}</h2>
      <p class="muted small">Recalculée à chaque test, chrono ou bilan. Plus haut = plus rapide.</p>
      ${lineChart(d.level, { fmt: (v) => duration(v).replace(/'00$/, ''), invert: true, empty: 'La courbe apparaîtra après ton premier recalibrage (bilan du lundi, test ou chrono).' })}</section>
    <section class="card"><h2>Efficacité en footing</h2>
      <p class="muted small">Mètres parcourus par battement de cœur. Si ça monte, tu cours plus vite pour le même effort : ton endurance progresse.${effDelta != null ? ` <strong>${effDelta >= 0 ? '+' : ''}${Math.round(effDelta * 100)} %</strong> depuis tes premiers footings.` : ''}</p>
      ${lineChart(d.eff, { fmt: (v) => v.toFixed(2).replace('.', ','), empty: 'Apparaîtra après quelques footings enregistrés avec ta montre (cardio).' })}</section>
    <section class="card"><h2>Volume par semaine</h2>
      <p class="muted small"><span class="key key-done"></span> réalisé · <span class="key key-plan"></span> prévu (km)</p>
      ${weeklyVolumeChart(d.volume)}</section>
    <section class="card"><h2>Forme &amp; fraîcheur</h2>
      <p class="muted small">Ta <strong>forme</strong> = ta charge d'entraînement de fond ; elle monte quand tu t'entraînes régulièrement, et c'est la vraie preuve que tu progresses.${d.loadNow?.zone ? ` <strong>Fraîcheur</strong> aujourd'hui : ta charge récente est <strong>${esc(LOAD_LABELS[d.loadNow.zone])}</strong>.` : ''}</p>
      ${lineChart(d.form, { fmt: (v) => Math.round(v), empty: 'Apparaîtra après ~2 semaines de séances enregistrées avec ta montre.' })}</section>
    ${d.tests.length ? `<section class="card"><h2>Tests VMA</h2><ul class="adj">${d.tests.map((x) => `<li>${esc(dateShort(x.date))} : ${x.vma.toFixed(1).replace('.', ',')} km/h</li>`).join('')}</ul></section>` : ''}
    <div id="chart-tip" class="chart-tip" hidden></div>`;
  bindChartTips();
  bindMonthly();
}

/** Valeur affichée au toucher (iPhone) ou au survol (ordinateur). */
export function bindChartTips() {
  const tip = view.querySelector('#chart-tip');
  const show = (g, ev) => {
    tip.textContent = g.dataset.tip;
    tip.hidden = false;
    const r = view.getBoundingClientRect();
    const x = Math.min(Math.max(ev.clientX - r.left, 80), r.width - 80);
    tip.style.left = `${x}px`;
    tip.style.top = `${ev.clientY - r.top - 48}px`;
    view.querySelectorAll('.pt.active').forEach((n) => n.classList.remove('active'));
    g.classList.add('active');
  };
  view.querySelectorAll('.chart .pt').forEach((g) => {
    g.addEventListener('pointerenter', (ev) => show(g, ev));
    g.addEventListener('click', (ev) => show(g, ev));
  });
  view.querySelectorAll('.chart').forEach((c) => c.addEventListener('pointerleave', () => { tip.hidden = true; }));
}

// ---------------- Bilan du mois ----------------

let shownMonth = null;
/** Ouvre l'onglet Progrès sur un mois donné. */
export function showMonth(m) { shownMonth = m; }
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`);
const fmtN = (n) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
const arrow = (d) => (d == null ? '' : `<small class="delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '▲' : d < 0 ? '▼' : '='} ${Math.abs(d)} %</small>`);

/** Carte « Bilan du mois » (mois en cours par défaut, navigation vers les mois précédents). */
export function monthlyCard(t, month = shownMonth ?? t.slice(0, 7)) {
  const months = availableMonths(state, t);
  if (!months.includes(month)) month = months.at(-1);
  shownMonth = month;
  const { cur, delta, lines } = monthlySummary(state, month, t);
  const i = months.indexOf(month);
  const row = (label, c, extra = '') => (c.n ? `<li><span>${label}</span><span>${c.n} × · ${fmtMin(c.min)}${extra} · ${c.kcalEstimated ? '≈ ' : ''}${fmtN(c.kcal)} kcal</span></li>` : '');
  return `<section class="card monthly" id="monthly">
    <div class="row between month-nav">
      <button class="btn ghost small-btn" data-month="${months[i - 1] ?? ''}" ${i > 0 ? '' : 'disabled'} aria-label="Mois précédent">‹</button>
      <h2>Bilan de ${esc(monthLabel(month))}</h2>
      <button class="btn ghost small-btn" data-month="${months[i + 1] ?? ''}" ${i < months.length - 1 ? '' : 'disabled'} aria-label="Mois suivant">›</button>
    </div>
    <div class="tiles four">
      <div class="tile"><span class="tile-value">${fmtN(cur.run.km)}</span><span class="tile-label">km courus ${arrow(delta.km)}</span></div>
      <div class="tile"><span class="tile-value">${fmtMin(cur.total.min)}</span><span class="tile-label">d'activité ${arrow(delta.min)}</span></div>
      <div class="tile"><span class="tile-value">${cur.total.kcalEstimated ? '≈' : ''}${fmtN(cur.total.kcal)}</span><span class="tile-label">kcal ${arrow(delta.kcal)}</span></div>
      <div class="tile"><span class="tile-value">${cur.total.sessions}</span><span class="tile-label">séances ${arrow(delta.sessions)}</span></div>
    </div>
    ${cur.total.sessions ? `<ul class="month-rows">
      ${row('Course', cur.run, ` · ${fmtN(cur.run.km)} km`)}
      ${row('Futsal', cur.futsal)}${row('Arbitrage', cur.referee)}${row('Renforcement', cur.strength)}${row('Autre', cur.other)}
    </ul>
    ${cur.run.n ? `<p class="muted small">Plus longue sortie ${fmtN(cur.run.longestKm)} km${cur.run.bestPace ? ` · meilleure allure moyenne ${pace(cur.run.bestPace)}/km` : ''}${cur.run.avgHr ? ` · FC moyenne ${cur.run.avgHr} bpm` : ''}.</p>` : ''}
    ${lines.length ? `<div class="coach-quote"><span class="coach-head">Le mot du coach</span>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>` : ''}
    ${cur.total.kcalEstimated ? '<p class="muted small">≈ : calories estimées pour les activités notées sans montre.</p>' : ''}`
    : '<p class="muted">Aucune activité ce mois-ci pour l\'instant.</p>'}
  </section>`;
}

function bindMonthly() {
  view.querySelectorAll('#monthly [data-month]').forEach((b) => b.addEventListener('click', () => {
    if (!b.dataset.month) return;
    view.querySelector('#monthly').outerHTML = monthlyCard(today(), b.dataset.month);
    bindMonthly();
  }));
}
