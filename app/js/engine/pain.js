// Douleurs signalées après les séances → conseil de prudence (prévention des blessures).
//
// Échelle simplifiée : 0 aucune · 2 légère (1–3/10) · 5 moyenne (4–6/10) · 8 forte (7–10/10).
//   forte                                   → arrêt : pause de 3 jours, avis médical si ça persiste ;
//   moyenne, ou même zone 2 fois en 7 jours → prudence : prochaine séance allégée ;
//   légère et même zone 3 fois en 14 jours → vigilance : la douleur s'installe.
// Ce n'est pas un diagnostic : l'app recommande de consulter dès qu'une douleur dure.

import { addDays } from './dates.js';

export const PAIN_ZONES = {
  knee: 'Genou', ankle: 'Cheville', achilles: 'Tendon d\'Achille', calf: 'Mollet', shin: 'Tibia',
  foot: 'Pied', hip: 'Hanche', thigh: 'Cuisse', back: 'Dos', other: 'Autre',
};
export const PAIN_LEVELS = { 0: 'Aucune', 2: 'Légère (1–3/10)', 5: 'Moyenne (4–6/10)', 8: 'Forte (7–10/10)' };

/** Douleurs des `days` derniers jours, de la plus récente à la plus ancienne. */
export function recentPains(plan, log, today, days = 14) {
  const from = addDays(today, -days);
  return plan.weeks.flatMap((w) => w.sessions)
    .map((s) => ({ s, e: log[s.id] }))
    .filter(({ s, e }) => e?.pain?.level > 0 && s.date >= from && s.date <= today)
    .map(({ s, e }) => ({ date: s.date, title: s.title, ...e.pain }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * @param resolvedAt date à laquelle l'utilisateur a indiqué « c'est passé » (les douleurs antérieures sont ignorées).
 * @returns null ou { level: 'stop'|'caution'|'watch', zone, text, actions: ['pause'|'ease'] }
 */
export function painAdvice(plan, log, today, resolvedAt = null) {
  const pains = recentPains(plan, log, today).filter((p) => !resolvedAt || p.date > resolvedAt);
  if (!pains.length) return null;
  const last = pains[0];
  const zone = PAIN_ZONES[last.zone] ?? 'zone non précisée';
  const sameZone = (days) => pains.filter((p) => p.zone === last.zone && p.date > addDays(today, -days)).length;

  if (last.level >= 8) {
    return {
      level: 'stop', zone,
      text: `Douleur forte (${zone}) signalée le ${last.date} : arrête la course quelques jours : une pause de 3 jours est conseillée. Si la douleur est encore là au repos, ou si elle revient dès la reprise, consulte un médecin ou un kiné avant de recourir.`,
      actions: ['pause'],
    };
  }
  if (last.level >= 5 || sameZone(7) >= 2) {
    return {
      level: 'caution', zone,
      text: `Douleur ${last.level >= 5 ? 'moyenne' : 'qui revient'} (${zone}). Allège la prochaine séance (footing court) et observe : si elle augmente pendant la course ou te fait boiter, arrête-toi. Si elle dure plus d'une semaine, consulte.`,
      actions: ['ease', 'pause'],
    };
  }
  if (sameZone(14) >= 3) {
    return {
      level: 'watch', zone,
      text: `Petite douleur (${zone}) signalée 3 fois en 2 semaines : elle s'installe. Ralentis, vérifie tes chaussures, et allège si elle grimpe.`,
      actions: ['ease'],
    };
  }
  return { level: 'watch', zone, text: `Petite douleur (${zone}) notée : surveille-la à la prochaine séance.`, actions: [] };
}
