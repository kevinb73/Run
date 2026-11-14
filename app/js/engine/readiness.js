// Forme du jour (disponibilité à l'entraînement Garmin, VFC, sommeil) → conseil pour la séance du jour.

import { HARD_TYPES } from './reschedule.js';

export const LEVEL_FR = { PRIME: 'excellente', HIGH: 'bonne', MODERATE: 'moyenne', LOW: 'basse', POOR: 'très basse' };
export const HRV_FR = { BALANCED: 'équilibrée', UNBALANCED: 'déséquilibrée', LOW: 'basse', POOR: 'très basse' };

/** Classe la forme : 'poor' | 'low' | 'ok' | null (pas de donnée). */
export function formClass(r) {
  if (!r) return null;
  const hrvBad = ['LOW', 'POOR'].includes(r.hrvStatus);
  if (r.score != null) {
    if (r.score < 25) return 'poor';
    if (r.score < 50 || hrvBad) return 'low';
    return 'ok';
  }
  if (hrvBad) return 'low';
  if (r.sleepScore != null && r.sleepScore < 50) return 'low';
  return r.hrvStatus || r.sleepScore != null ? 'ok' : null;
}

/**
 * @returns { action: 'swap'|'suggest'|'shorten'|'none', text } ou null
 *   swap    : forme très basse + séance dure → footing aujourd'hui, séance dure décalée ;
 *   suggest : forme basse + séance dure → proposer d'alléger ;
 *   shorten : forme très basse + footing → raccourcir.
 */
export function readinessAdvice(r, session) {
  const f = formClass(r);
  if (!f || !session) return null;
  const hard = HARD_TYPES.includes(session.type);
  if (f === 'poor' && hard) return { action: 'swap', text: 'Forme très basse aujourd\'hui : une séance dure ferait plus de mal que de bien. Fais un footing tranquille, la séance dure est décalée.' };
  if (f === 'low' && hard) return { action: 'suggest', text: 'Forme basse aujourd\'hui (récupération incomplète). Tu peux alléger : footing aujourd\'hui, séance dure décalée.' };
  if (f === 'poor') return { action: 'shorten', text: 'Forme très basse : raccourcis ton footing d\'un tiers, ou repose-toi.' };
  return { action: 'none', text: f === 'ok' ? 'Feu vert pour la séance prévue.' : 'Forme un peu basse : reste bien à l\'aise.' };
}
