import { upgradePlan } from './engine/upgrade.js';
import { monthlySummary, monthLabel, prevMonth } from './engine/monthly.js';
import { esc } from './format.js';
import { closeSheet, onPause, persist, showSheet, state, tabbar, today } from './core.js';
import { renderOnboarding } from './pages/onboarding.js';
import { renderPlan } from './pages/plan.js';
import { renderProfile } from './pages/profile.js';
import { renderProgress, showMonth } from './pages/progress.js';
import { renderRecap } from './pages/recap.js';
import { renderSession } from './pages/session.js';
import { renderToday } from './pages/today.js';
import { pushWeek, refreshPushed } from './sync.js';

/** Nouvelle version du moteur : la suite du plan est recalculée automatiquement, l'historique reste intact. */
export function maybeUpgradePlan() {
  const t = today();
  const r = upgradePlan(state.plan, state.log, t, { paused: onPause(t) });
  if (!r) return;
  state.plan = r.plan;
  persist();
  if (r.notes.length) {
    refreshPushed().then(() => pushWeek({ silent: true }));
    setTimeout(() => showSheet(`<h2>Plan mis à jour</h2>
      <p>Nouveauté : <strong>${esc(r.notes.join(' ; '))}</strong>.</p>
      <p class="muted">Ton historique est intact ; seule la suite du plan a été recalculée, à partir de ton niveau actuel.</p>
      <button class="btn primary" data-close>OK</button>`), 300);
  }
}

export /** Début de mois : le bilan du mois écoulé s'affiche une fois. */
function maybeMonthlyRecap() {
  const t = today();
  if (Number(t.slice(8, 10)) > 7) return;
  const m = prevMonth(t.slice(0, 7));
  if (state.monthlyShown === m) return;
  const { cur } = monthlySummary(state, m, t);
  state.monthlyShown = m;
  persist();
  if (!cur.total.sessions) return;
  setTimeout(() => showSheet(`<h2>Ton bilan de ${esc(monthLabel(m))}</h2>
    <p><strong>${cur.total.sessions} séances</strong> · ${Number(cur.run.km).toLocaleString('fr-FR')} km courus · ${cur.total.kcalEstimated ? '≈ ' : ''}${cur.total.kcal.toLocaleString('fr-FR')} kcal</p>
    <button class="btn primary" id="see-month">Voir le bilan complet</button><button class="btn" data-close>Plus tard</button>`, (sh) => {
    sh.querySelector('#see-month').addEventListener('click', () => { showMonth(m); closeSheet(); location.hash = '#/progress'; });
  }), 400);
}

function route() {
  const hash = location.hash.slice(1) || '/';
  const [, page, arg] = hash.split('/');
  if (!state.plan && page !== 'onboarding') { location.replace('#/onboarding'); return; }
  if (state.plan) maybeUpgradePlan();
  if (state.plan && page !== 'progress') maybeMonthlyRecap();
  tabbar.hidden = page === 'onboarding';
  for (const a of tabbar.querySelectorAll('a')) a.classList.toggle('active', a.dataset.page === (page || 'today'));
  window.scrollTo(0, 0);
  switch (page) {
    case 'onboarding': return renderOnboarding();
    case 'plan': return renderPlan(arg);
    case 'session': return renderSession(arg);
    case 'profile': return renderProfile();
    case 'progress': return renderProgress();
    case 'recap': return renderRecap(arg);
    default: return renderToday();
  }
}


// Affiche le choix de la zone dès qu'une douleur est cochée (délégation : vaut pour tous les formulaires).
document.addEventListener('change', (ev) => {
  if (ev.target.name !== 'painLevel') return;
  const zone = ev.target.closest('form, .sheet')?.querySelector('.pain-zone');
  if (zone) zone.hidden = ev.target.value === '0';
});

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
