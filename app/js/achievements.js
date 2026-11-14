// Affichage du bloc « motivation » : célébration des nouveautés (Aujourd'hui) et carte Records & jalons (Progrès).
import { computeRecords, newAchievements } from './engine/records.js';
import { addDays } from './engine/dates.js';
import { esc, pace, duration, dateShort } from './format.js';
import { state, persist, today } from './core.js';

export const fmtRecord = (r) => (r.fmt === 'km' ? `${Number(r.value).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`
  : r.fmt === 'pace' ? `${pace(r.value)}/km` : duration(Math.round(r.value)));

/** Carte de célébration sur l'écran Aujourd'hui (records battus / jalons des 3 derniers jours, non encore vus). */
export function celebrationCard(t = today()) {
  const news = newAchievements(state, addDays(t, -3), state.seenAchievements ?? {}, t);
  if (!news.length) return '';
  return `<section class="card celebrate" id="celebrate">
    <p class="coach-head">${news.length > 1 ? 'Bravo, nouveautés' : 'Bravo'}</p>
    ${news.map((n) => n.kind === 'record'
      ? `<p><strong>🏅 Nouveau record · ${esc(n.label)} :</strong> ${esc(fmtRecord(n))} <span class="muted">(avant : ${esc(fmtRecord({ ...n, value: n.prev }))})</span></p>`
      : `<p><strong>🎯 Cap franchi :</strong> ${esc(n.label)} <span class="muted">· ${esc(dateShort(n.date))}</span></p>`).join('')}
    <button class="btn" id="celebrate-ok" data-ids="${esc(news.map((n) => n.id).join(','))}">Super !</button>
  </section>`;
}

export function bindCelebration(root, rerender) {
  root.querySelector('#celebrate-ok')?.addEventListener('click', (ev) => {
    state.seenAchievements = { ...(state.seenAchievements ?? {}) };
    for (const id of ev.currentTarget.dataset.ids.split(',')) state.seenAchievements[id] = true;
    persist();
    rerender();
  });
}

/** Carte Records & jalons (Progrès). */
export function recordsCard(t = today()) {
  const { records, milestones, totalKm, streak, nRuns } = computeRecords(state, t);
  if (!nRuns) return '<section class="card"><h2>Records & jalons</h2><p class="muted">Ils apparaîtront après ta première course enregistrée.</p></section>';
  const next = milestones.find((m) => !m.date);
  return `<section class="card records">
    <h2>Records & jalons</h2>
    ${streak.current || streak.best ? `<div class="streak"><span class="streak-n">${streak.current}</span><span>semaine${streak.current > 1 ? 's' : ''} régulière${streak.current > 1 ? 's' : ''} d'affilée<small class="muted">toutes tes courses prévues faites · record : ${streak.best}</small></span></div>`
      : '<p class="muted">Série de semaines régulières : elle démarre dès ta première semaine complète (toutes les courses prévues faites).</p>'}
    <ul class="month-rows">${Object.values(records).map((r) => `<li><span>${esc(r.label)}</span><span><strong>${esc(fmtRecord(r))}</strong> · ${esc(dateShort(r.date))}</span></li>`).join('')}
      <li><span>Total couru</span><span><strong>${Number(totalKm).toLocaleString('fr-FR')} km</strong> · ${nRuns} course${nRuns > 1 ? 's' : ''}</span></li></ul>
    ${next ? `<p class="next-milestone">Prochain cap : <strong>${esc(next.label)}</strong></p>` : ''}
    <div class="milestones">${milestones.map((m) => `<span class="ms ${m.date ? 'done' : ''}" title="${m.date ? esc(dateShort(m.date)) : 'à venir'}">${m.date ? '✓ ' : ''}${esc(m.label)}</span>`).join('')}</div>
  </section>`;
}
