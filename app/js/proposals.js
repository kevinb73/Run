// Propositions de ChatGPT : affichées sur l'écran Aujourd'hui, appliquées seulement si l'utilisateur accepte.
// C'est l'app (et ses règles de sécurité) qui modifie le plan, jamais ChatGPT directement.
import { moveSession, downgradeToEasy, shortenEasy, HARD_TYPES } from './engine/reschedule.js';
import { pausePlan, PAUSE_REASONS } from './engine/pause.js';
import { api } from './garmin.js';
import { esc, dateLong } from './format.js';
import { state, persist, toast, today, garminOn, findSession, showSheet } from './core.js';
import { refreshPushed, repushIfNeeded } from './sync.js';

let lastFetch = 0;

/** Récupère les propositions en attente (au plus une fois par minute). */
export async function fetchProposals(force = false) {
  if (!garminOn() || (!force && Date.now() - lastFetch < 60_000)) return false;
  lastFetch = Date.now();
  try {
    const { proposals } = await api(state.garmin, 'GET', '/proposals?status=pending');
    const before = JSON.stringify(state.proposals ?? []);
    state.proposals = proposals;
    if (JSON.stringify(proposals) !== before) { persist(); return true; }
  } catch { /* serveur indisponible : on réessaiera */ }
  return false;
}

/** Texte lisible d'une proposition. */
export function describe(p) {
  const s = p.seance_id ? findSession(p.seance_id) : null;
  const title = esc(s?.title ?? p.titre ?? 'la séance');
  switch (p.action) {
    case 'deplacer': return `Déplacer <strong>${title}</strong> du ${esc(dateLong(p.date))} au <strong>${esc(dateLong(p.nouvelle_date))}</strong>`;
    case 'alleger': return `Alléger <strong>${title}</strong> du ${esc(dateLong(p.date))}`;
    case 'sauter': return `Sauter <strong>${title}</strong> du ${esc(dateLong(p.date))}`;
    case 'pause': return `Faire une <strong>pause de ${p.jours} jour${p.jours > 1 ? 's' : ''}</strong> (${esc((PAUSE_REASONS[p.motif] ?? 'autre').toLowerCase())})`;
    default: return esc(p.action);
  }
}

/** Vérifie qu'une proposition est encore applicable (la séance peut avoir été faite, déplacée…). */
export function stillValid(p, t = today()) {
  if (p.action === 'pause') return !state.pause || t >= state.pause.until;
  const s = findSession(p.seance_id);
  if (!s || state.log[s.id]?.done || state.log[s.id]?.skipped || s.date < t) return false;
  if (p.action === 'deplacer') return p.nouvelle_date >= t;
  return true;
}

/** Applique la proposition avec les fonctions du moteur. @returns texte de résultat */
export function applyProposal(p, t = today()) {
  if (!stillValid(p, t)) throw new Error('Proposition dépassée : la séance a été faite, déplacée ou la date est passée.');
  if (p.action === 'pause') {
    const r = pausePlan(state.plan, state.log, t, p.jours, p.motif);
    state.plan = r.plan; state.pause = r.pause;
    return 'Pause enregistrée, reprise en douceur prévue.';
  }
  const s = findSession(p.seance_id);
  if (p.action === 'deplacer') {
    const { plan, conflict } = moveSession(state.plan, s.id, p.nouvelle_date, state.log);
    state.plan = plan;
    return conflict ? 'Séance déplacée. Attention : une autre séance dure suit le lendemain.' : 'Séance déplacée.';
  }
  if (p.action === 'alleger') {
    state.plan = HARD_TYPES.includes(s.type) || s.type === 'long' ? downgradeToEasy(state.plan, s.id) : shortenEasy(state.plan, s.id);
    return 'Séance allégée.';
  }
  if (p.action === 'sauter') {
    state.log[s.id] = { skipped: true, at: t, reason: 'chatgpt' };
    return 'Séance sautée.';
  }
  throw new Error('Action inconnue.');
}

async function decide(p, status, note) {
  state.proposals = (state.proposals ?? []).filter((x) => x.id !== p.id);
  persist();
  try { await api(state.garmin, 'POST', `/proposals/${encodeURIComponent(p.id)}`, { status, note }); } catch { /* sera ignorée : plus « en attente » localement */ }
}

/** Cartes « ChatGPT propose » (écran Aujourd'hui). */
export function proposalsCard(t = today()) {
  const list = (state.proposals ?? []);
  if (!list.length) return '';
  return list.map((p) => `<section class="card proposal" data-pid="${esc(p.id)}">
    <p class="coach-head">ChatGPT propose</p>
    <p>${describe(p)}</p>
    <p class="muted">${esc(p.raison ?? '')}</p>
    ${stillValid(p, t) ? `<div class="actions"><button class="btn ghost" data-refuse="${esc(p.id)}">Refuser</button><button class="btn primary" data-apply="${esc(p.id)}">Appliquer</button></div>`
      : `<p class="muted small">Plus applicable (séance faite, déplacée ou date passée).</p><button class="btn ghost" data-refuse="${esc(p.id)}">Retirer</button>`}
  </section>`).join('');
}

export function bindProposals(root, rerender) {
  root.querySelectorAll('[data-apply]').forEach((b) => b.addEventListener('click', async () => {
    const p = state.proposals.find((x) => x.id === b.dataset.apply);
    try {
      const before = new Set(state.plan.weeks.flatMap((w) => w.sessions).map((s) => `${s.id}@${s.date}`));
      const msg = applyProposal(p);
      await decide(p, 'applied', msg);
      const changed = state.plan.weeks.flatMap((w) => w.sessions).filter((s) => !before.has(`${s.id}@${s.date}`)).map((s) => s.id);
      if (p.action === 'pause' || p.action === 'sauter') refreshPushed(); else repushIfNeeded([p.seance_id, ...changed]);
      showSheet(`<h2>Proposition appliquée</h2><p>${esc(msg)}</p><p class="muted">Ta montre est mise à jour.</p><button class="btn primary" data-close>OK</button>`);
    } catch (ex) {
      await decide(p, 'failed', ex.message);
      toast(ex.message);
    }
    rerender();
  }));
  root.querySelectorAll('[data-refuse]').forEach((b) => b.addEventListener('click', async () => {
    const p = state.proposals.find((x) => x.id === b.dataset.refuse);
    await decide(p, 'refused', null);
    toast('Proposition refusée.');
    rerender();
  }));
}
