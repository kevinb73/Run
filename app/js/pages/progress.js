import { lineChart, volumeChart as weeklyVolumeChart, progressData } from '../progress.js';
import { esc, duration, dateShort } from '../format.js';
import { state, today, view } from '../core.js';

export function renderProgress() {
  const t = today();
  const d = progressData(state, t);
  const lastVma = d.tests.at(-1);
  const effDelta = d.eff.length >= 4
    ? (d.eff.slice(-3).reduce((a, x) => a + x.y, 0) / 3) / (d.eff.slice(0, 3).reduce((a, x) => a + x.y, 0) / 3) - 1 : null;
  view.innerHTML = `<h1>Progrès</h1>
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
    ${d.tests.length ? `<section class="card"><h2>Tests VMA</h2><ul class="adj">${d.tests.map((x) => `<li>${esc(dateShort(x.date))} : ${x.vma.toFixed(1).replace('.', ',')} km/h</li>`).join('')}</ul></section>` : ''}
    <div id="chart-tip" class="chart-tip" hidden></div>`;
  bindChartTips();
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
