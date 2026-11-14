// Pause (maladie, blessure, vacances) : on suspend le plan puis on reprend en douceur.
//
// Règles (désentraînement) : la forme baisse peu la 1re semaine, puis plus vite.
//   ≤ 3 jours   → volume de reprise 90 %, allures inchangées ;
//   4–7 jours   → 80 % ;
//   8–14 jours  → 65 %, allures un peu ralenties ;
//   > 14 jours  → 50 %, allures ralenties davantage.
// En remise en forme, la fin du cycle est repoussée d'autant ; en préparation de course, la date reste fixe.

import { generatePlan } from './plan.js';
import { addDays, mondayOf, daysBetween } from './dates.js';
import { currentWeek } from './adapt.js';

export const PAUSE_REASONS = { illness: 'Maladie', injury: 'Blessure / douleur', holiday: 'Vacances', other: 'Autre' };

export function resumeFactors(days) {
  if (days <= 3) return { volume: 0.9, vdot: 0 };
  if (days <= 7) return { volume: 0.8, vdot: 0 };
  if (days <= 14) return { volume: 0.65, vdot: -1 };
  return { volume: 0.5, vdot: -Math.min(4, 1 + (days - 14) / 7) };
}

/**
 * @param from    premier jour de pause (en général aujourd'hui)
 * @param days    durée de la pause en jours (reprise le jour from + days)
 * @param reason  clé de PAUSE_REASONS
 * @returns { plan, pause: { from, until, reason }, adjustment }
 */
export function pausePlan(plan, log, from, days, reason = 'other', opts = {}) {
  const resume = addDays(from, days);
  const cur = currentWeek(plan, from) ?? plan.weeks.find((w) => w.start > from) ?? plan.weeks.at(-1);
  const f = resumeFactors(opts.factorDays ?? days);
  const fitness = plan.mode === 'fitness';
  const profile = { ...plan.profile };
  if (fitness && profile.raceDate) profile.raceDate = addDays(profile.raceDate, days);
  if (profile.fitnessGoal === 'restart' && profile.durationWeeks) {
    const elapsed = Math.max(0, Math.floor(daysBetween(plan.weeks[0].start, from) / 7));
    profile.durationWeeks = Math.max(4, profile.durationWeeks - elapsed);
  }

  // On ne régénère jamais la semaine en cours (elle contient l'historique) : au plus tôt le lundi suivant.
  const nextMonday = addDays(mondayOf(from), 7);
  const newStart = mondayOf(resume) > nextMonday ? mondayOf(resume) : nextMonday;
  const reasons = [opts.label ?? `Pause de ${days} jour${days > 1 ? 's' : ''} (${PAUSE_REASONS[reason] ?? reason}) : reprise le ${resume}.`];
  const keepSessions = (w) => ({ ...w, sessions: w.sessions.filter((s) => s.date < from || log?.[s.id]?.done || (s.date < newStart && s.date >= resume)) });

  // Préparation de course : si la course arrive trop vite après la reprise, on retire seulement les jours de pause.
  const tooClose = !fitness && daysBetween(newStart, mondayOf(profile.raceDate)) < 7;
  if (tooClose) {
    reasons.push('Course trop proche pour recalculer : on retire les séances de la pause et on garde la fin du plan.');
    const weeks = plan.weeks.map((w) => ({ ...w, sessions: w.sessions.filter((s) => s.date < from || log?.[s.id]?.done || s.date >= resume) }));
    const adjustment = { date: from, reasons, vdotBefore: cur.vdot, vdotAfter: cur.vdot, changed: true };
    return { plan: { ...plan, weeks, adjustments: [...(plan.adjustments ?? []), adjustment] }, pause: { from, until: resume, reason }, adjustment };
  }

  const keep = plan.weeks.filter((w) => w.start < newStart).map(keepSessions);
  profile.weeklyKm = Math.max(5, Math.round(cur.volumeKm * f.volume));
  const vdot = Math.max(15, cur.vdot + f.vdot);
  if (f.volume < 1) reasons.push(`Reprise à ${Math.round(f.volume * 100)} % du volume pour laisser le corps se réhabituer.`);
  if (f.vdot < 0) reasons.push('Allures légèrement ralenties après cette coupure : elles remonteront avec tes premières séances.');
  if (fitness) reasons.push('La fin du cycle est repoussée d\'autant.');

  let fresh;
  try {
    fresh = generatePlan(profile, {
      today: resume, startDate: newStart, vdotStart: vdot,
      weekOffset: keep.length ? keep.at(-1).index + 1 : 0,
    });
  } catch {
    // Fin de plan trop proche pour recalculer : on retire simplement les séances de la pause.
    const weeks = plan.weeks.map((w) => ({ ...w, sessions: w.sessions.filter((s) => s.date < from || log?.[s.id]?.done || s.date >= resume) }));
    const adjustment = { date: from, reasons, vdotBefore: cur.vdot, vdotAfter: cur.vdot, changed: true };
    return { plan: { ...plan, weeks, adjustments: [...(plan.adjustments ?? []), adjustment] }, pause: { from, until: resume, reason }, adjustment };
  }
  const adjustment = { date: from, reasons, vdotBefore: cur.vdot, vdotAfter: Math.round(vdot * 10) / 10, changed: true };
  return {
    plan: {
      ...fresh,
      createdAt: plan.createdAt,
      profile: fresh.profile,
      vdotStart: plan.vdotStart,
      warnings: fresh.warnings.filter((w) => !w.startsWith('Niveau estimé') && !w.startsWith('Allures calculées')),
      adjustments: [...(plan.adjustments ?? []), adjustment],
      weeks: [...keep, ...fresh.weeks],
    },
    pause: { from, until: resume, reason },
    adjustment,
  };
}

/** Reprise avant la date prévue : le plan repart aujourd'hui, allégé selon la durée réelle de la pause. */
export function resumeEarly(plan, log, pause, today) {
  const paused = Math.max(0, daysBetween(pause.from, today));
  const remaining = Math.max(0, daysBetween(today, pause.until));
  const p = structuredClone(plan);
  if (p.mode === 'fitness' && p.profile.raceDate) p.profile.raceDate = addDays(p.profile.raceDate, -remaining);
  return pausePlan(p, log, today, 0, pause.reason, {
    factorDays: paused,
    label: `Reprise anticipée après ${paused} jour${paused > 1 ? 's' : ''} de pause.`,
  });
}
