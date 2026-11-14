import { downgradeToEasy, shortenEasy, HARD_TYPES } from './engine/reschedule.js';
import { pausePlan, resumeEarly, PAUSE_REASONS } from './engine/pause.js';
import { painAdvice } from './engine/pain.js';
import { addDays } from './engine/dates.js';
import { esc, dateLong, dateShort } from './format.js';
import { route } from './app.js';
import { allSessions, closeSheet, findSession, frDates, onPause, persist, showSheet, state, toast, today, view } from './core.js';
import { renderToday } from './pages/today.js';
import { refreshPushed, repushIfNeeded } from './sync.js';

export function pauseBlock(t) {
  if (!onPause(t)) return '';
  return `<section class="card warn"><h2>⏸ En pause</h2>
    <p>${esc(PAUSE_REASONS[state.pause.reason] ?? '')} · reprise prévue le <strong>${esc(dateLong(state.pause.until))}</strong>.</p>
    <p class="muted">Repose-toi vraiment : marche, sommeil, et pas de course « pour voir ».</p>
    <button class="btn" id="resume-now">Je reprends dès aujourd'hui</button></section>`;
}

export function painBlock(t) {
  if (onPause(t)) return '';
  const adv = painAdvice(state.plan, state.log, t, state.painResolvedAt);
  if (!adv) return '';
  const cls = adv.level === 'stop' ? 'warn danger' : adv.level === 'caution' ? 'warn' : '';
  return `<section class="card ${cls}"><h2>${adv.level === 'stop' ? '🛑' : '⚠️'} Douleur : ${esc(adv.zone)}</h2><p>${esc(frDates(adv.text))}</p>
    <div class="actions wrap">
      ${adv.actions.includes('pause') ? '<button class="btn primary" id="pain-pause">Pause de 3 jours</button>' : ''}
      ${adv.actions.includes('ease') ? '<button class="btn" id="pain-ease">Alléger la prochaine séance</button>' : ''}
      <button class="btn ghost" id="pain-ok">C'est passé</button>
    </div></section>`;
}

export function applyPause(days, reason) {
  const t = today();
  const r = pausePlan(state.plan, state.log, t, days, reason);
  state.plan = r.plan;
  state.pause = r.pause;
  persist();
  refreshPushed();
  showSheet(`<h2>Pause enregistrée</h2><ul>${r.adjustment.reasons.map((x) => `<li>${esc(frDates(x))}</li>`).join('')}</ul>
    <p class="muted">Les séances de la pause sont retirées de ta montre.</p><button class="btn primary" data-close>OK</button>`);
  location.hash = '#/';
  route();
}

export function pauseSheet() {
  showSheet(`<h2>Faire une pause</h2>
    <form id="pz"><p class="field-label">Pourquoi ?</p>
    <div class="choices">${Object.entries(PAUSE_REASONS).map(([k, l]) => `<label class="choice small"><input type="radio" name="reason" value="${k}" ${k === 'illness' ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>
    <p class="field-label">Combien de temps ?</p>
    <div class="choices">${[3, 5, 7, 10, 14, 21].map((d) => `<label class="choice small"><input type="radio" name="days" value="${d}" ${d === 7 ? 'checked' : ''}><span>${d} jours</span></label>`).join('')}</div>
    <p class="hint">En cas de maladie : pas de course avec de la fièvre ou des symptômes sous le cou (toux, courbatures). Tu pourras reprendre plus tôt si besoin.</p>
    <button class="btn primary" type="submit">Mettre le plan en pause</button></form>`, (sheet) => {
    sheet.querySelector('#pz').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = ev.currentTarget;
      closeSheet();
      applyPause(Number(f.querySelector('[name=days]:checked').value), f.querySelector('[name=reason]:checked').value);
    });
  });
}

export function bindCareBlocks(t) {
  view.querySelector('#resume-now')?.addEventListener('click', () => {
    const r = resumeEarly(state.plan, state.log, state.pause, t);
    state.plan = r.plan;
    state.pause = null;
    persist();
    refreshPushed();
    toast('Plan relancé à partir d\'aujourd\'hui, en douceur.');
    renderToday();
  });
  view.querySelector('#pain-pause')?.addEventListener('click', () => {
    state.painResolvedAt = t;
    applyPause(3, 'injury');
  });
  view.querySelector('#pain-ease')?.addEventListener('click', () => {
    const nx = allSessions().find((s) => s.date >= t && s.date <= addDays(t, 3) && !s.optional && !state.log[s.id] && s.type !== 'race');
    if (!nx) { toast('Pas de séance dans les 3 prochains jours.'); return; }
    if (HARD_TYPES.includes(nx.type) || nx.type === 'long') state.plan = downgradeToEasy(state.plan, nx.id);
    state.plan = shortenEasy(state.plan, nx.id, 0.6);
    persist();
    repushIfNeeded([nx.id]);
    toast(`« ${findSession(nx.id).title} » du ${dateShort(nx.date)} allégée.`);
    renderToday();
  });
  view.querySelector('#pain-ok')?.addEventListener('click', () => {
    state.painResolvedAt = t;
    persist();
    renderToday();
  });
}
