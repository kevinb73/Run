// Changer ses jours (course, sortie longue, sports) sans refaire le plan.
//
// On garde tout le passé (séances, historique) et on recalcule seulement l'avenir, à partir d'aujourd'hui,
// en repartant du niveau atteint : allures (VDOT) et volume de la semaine en cours, sortie longue en cours.
// La date de fin (course ou fin de cycle) ne bouge pas.

import { generatePlan } from './plan.js';
import { addDays, mondayOf } from './dates.js';
import { currentWeek } from './adapt.js';

const DAY_FR = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

export function replanDays(plan, log, today, patch, opts = {}) {
  const profile = { ...plan.profile, ...patch };
  if (plan.mode === 'fitness' && profile.raceDate && patch.longRunDay != null) {
    profile.raceDate = addDays(mondayOf(profile.raceDate), profile.longRunDay);
  }
  const notStarted = today < plan.weeks[0].start;
  const cur = notStarted ? plan.weeks[0] : (currentWeek(plan, today) ?? plan.weeks.find((w) => w.start > today));
  if (!cur) throw new Error('Plan terminé : refais un nouveau cycle.');

  // Reprise de la course : on recalcule sur les semaines restantes (sinon la progression repartirait de zéro).
  if (profile.fitnessGoal === 'restart' && !notStarted) profile.durationWeeks = Math.max(4, plan.weeks.at(-1).index - cur.index + 1);

  let fresh;
  if (notStarted) {
    fresh = generatePlan(profile, { today, startDate: plan.weeks[0].start });
  } else {
    const longNow = cur.sessions.filter((s) => s.type === 'long').map((s) => s.km)[0];
    // Semaine allégée en cours : on repart du volume « normal » (sinon la suite démarrerait 25 % trop bas).
    const baseKm = cur.recovery ? cur.volumeKm / 0.75 : cur.volumeKm;
    fresh = generatePlan({ ...profile, weeklyKm: Math.round(baseKm), longestRunKm: longNow ?? profile.longestRunKm }, {
      today, startDate: cur.start, vdotStart: cur.vdot, weekOffset: cur.index,
    });
  }

  // Semaine en cours : passé + séances faites conservés ; le jour même, pas de doublon si une séance est déjà faite.
  const doneToday = plan.weeks.flatMap((w) => w.sessions).some((s) => s.date === today && log?.[s.id]?.done);
  const keepOld = (s) => s.date < today || log?.[s.id]?.done || log?.[s.id]?.skipped;
  const before = plan.weeks.filter((w) => w.start < cur.start);
  const merged = fresh.weeks.map((w) => {
    if (w.start !== cur.start) return w;
    const old = cur.sessions.filter(keepOld);
    const ids = new Set(old.map((s) => s.id));
    const add = w.sessions.filter((s) => (doneToday ? s.date > today : s.date >= today) && !ids.has(s.id));
    // Footing bonus à venir (ajouté à la main) : conservé.
    const bonus = cur.sessions.filter((s) => s.bonus && !keepOld(s) && !add.some((x) => x.id === s.id));
    add.push(...bonus);
    return { ...w, sessions: [...old, ...add].sort((a, b) => a.date.localeCompare(b.date)) };
  });

  const days = [...profile.days].sort((a, b) => a - b).map((d) => DAY_FR[d]).join(', ');
  const reasons = [opts.reason ?? `Jours modifiés : course le ${days}, sortie longue le ${DAY_FR[profile.longRunDay]}. Historique conservé, la suite est recalculée.`];
  const adjustment = { date: today, reasons, vdotBefore: cur.vdot, vdotAfter: cur.vdot, changed: true };
  return {
    plan: {
      ...fresh,
      createdAt: plan.createdAt,
      vdotStart: plan.vdotStart,
      profile: { ...fresh.profile, weeklyKm: plan.profile.weeklyKm, longestRunKm: plan.profile.longestRunKm },
      warnings: plan.warnings,
      adjustments: [...(plan.adjustments ?? []), adjustment],
      weeks: [...before, ...merged],
    },
    adjustment,
  };
}
