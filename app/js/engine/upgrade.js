// Mise à niveau automatique d'un plan existant quand le moteur évolue (nouvelle version de l'app).
//
// Principe : on ne jette jamais le plan. Le passé et les séances faites restent tels quels ;
// la suite est recalculée avec le nouveau moteur, à partir du niveau atteint (même logique que « Mes jours »).
// On ne touche à rien pendant une pause (la reprise recalculera déjà la suite).

import { ENGINE_VERSION } from './plan.js';
import { replanDays } from './replan.js';

/** Nouveautés par version du moteur (affichées à l'utilisateur après la mise à niveau). */
export const ENGINE_NOTES = {
  2: 'renforcement chevilles / genoux ajouté (2 × 15 min par semaine)',
};

/** @returns null si rien à faire, sinon { plan, notes } */
export function upgradePlan(plan, log, today, { paused = false } = {}) {
  const from = plan.engine ?? 1;
  if (from >= ENGINE_VERSION || paused) return null;
  const notes = Object.entries(ENGINE_NOTES).filter(([v]) => Number(v) > from).map(([, n]) => n);
  const lastDay = plan.weeks.at(-1)?.start;
  // Plan terminé (ou presque) : on note simplement la version.
  if (!lastDay || today >= lastDay) return { plan: { ...plan, engine: ENGINE_VERSION }, notes: [] };
  try {
    const reason = `Plan mis à jour avec la nouvelle version de l'app : ${notes.join(' ; ')}. Historique conservé.`;
    const r = replanDays(plan, log, today, {}, { reason });
    return { plan: { ...r.plan, engine: ENGINE_VERSION }, notes };
  } catch {
    return { plan: { ...plan, engine: ENGINE_VERSION }, notes: [] };
  }
}
