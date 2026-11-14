// Réajustement du plan "comme un coach" : à partir des séances réalisées et du ressenti,
// on recalcule les semaines à venir (niveau, volume). Les semaines passées sont conservées.

import { generatePlan } from './plan.js';
import { vdotFromPerformance } from './vdot.js';
import { addDays, mondayOf, daysBetween } from './dates.js';
import { dataSignals } from './coach.js';

/**
 * Bilan des 14 derniers jours.
 * log : { [sessionId]: { done: boolean, feel: 'easy'|'ok'|'hard', rpe?: number, actualKm?: number } }
 */
export function recentStats(plan, log, today) {
  const from = addDays(today, -14);
  const planned = plan.weeks.flatMap((w) => w.sessions)
    .filter((s) => s.date >= from && s.date < today && s.type !== 'race' && !s.optional);
  const entries = planned.map((s) => ({ s, e: log[s.id] }));
  const done = entries.filter((x) => x.e?.done);
  const feels = done.map((x) => x.e.feel).filter(Boolean);
  const share = (f) => (feels.length ? feels.filter((x) => x === f).length / feels.length : 0);
  const km = done.reduce((sum, x) => sum + (x.e.actualKm ?? x.s.km), 0);
  return {
    planned: planned.length,
    done: done.length,
    completion: planned.length ? done.length / planned.length : null,
    hardShare: share('hard'),
    easyShare: share('easy'),
    kmPerWeek: km / 2,
  };
}

/** Semaine en cours du plan (ou null). */
export function currentWeek(plan, today) {
  return plan.weeks.find((w) => w.start <= today && today < addDays(w.start, 7)) ?? null;
}

/**
 * Recalcule le plan à partir de lundi prochain.
 * @param newRace Optionnel : { distanceM, timeSec } d'une course ou d'un test récent.
 * @returns { plan, adjustment } ; adjustment décrit les décisions prises (affiché à l'utilisateur).
 */
export function adaptPlan(plan, log, today, newRace = null, hr = null, load = null) {
  const stats = recentStats(plan, log, today);
  const cur = currentWeek(plan, today) ?? plan.weeks[0];
  let vdot = cur.vdot;
  const reasons = [];

  if (newRace) {
    let v = vdotFromPerformance(newRace.distanceM, newRace.timeSec);
    const shortTest = newRace.timeSec <= 600;
    if (shortTest) {
      const vma = newRace.distanceM / (newRace.timeSec / 60) * 0.06; // km/h
      reasons.push(`Test : VMA estimée à ${vma.toFixed(1).replace('.', ',')} km/h.`);
    }
    // Un test court mesure la VMA, pas l'endurance : on limite la hausse pour ne pas surestimer les footings et le seuil.
    if (shortTest && v - vdot > 3) {
      reasons.push(`Ton test est bien au-dessus de ton niveau d'endurance actuel : hausse limitée à +3 pour l'instant (${vdot.toFixed(1)} → ${(vdot + 3).toFixed(1)} au lieu de ${v.toFixed(1)}). Le bilan du lundi (cœur + allure) affinera.`);
      v = vdot + 3;
    } else {
      reasons.push(`Nouveau chrono de référence : niveau recalculé (${vdot.toFixed(1)} → ${v.toFixed(1)}).`);
    }
    vdot = v;
  } else if (stats.done >= 3 && stats.hardShare >= 0.5) {
    vdot -= 0.7;
    reasons.push('Plus de la moitié des séances ressenties comme dures : allures assouplies.');
  } else if (stats.done >= 3 && stats.easyShare >= 0.6 && stats.completion >= 0.9) {
    vdot += 0.5;
    reasons.push('Séances faciles et régulières : allures légèrement relevées.');
  }

  // Données réelles Garmin (allure + cœur sur les footings) : prioritaires sur le seul ressenti.
  const signals = newRace ? null : dataSignals(plan, log, today, hr);
  if (signals?.reasons.length) {
    const feelDelta = vdot - cur.vdot;
    vdot = cur.vdot + Math.max(-1, Math.min(1, feelDelta + signals.deltaVdot));
    reasons.push(...signals.reasons);
  }

  let weeklyKm = plan.profile.weeklyKm;
  if (stats.completion != null) {
    // Base de volume : la cible de la semaine en cours, corrigée par ce qui est réellement fait.
    weeklyKm = cur.volumeKm;
    if (stats.completion < 0.6) {
      weeklyKm = Math.max(stats.kmPerWeek, cur.volumeKm * 0.7);
      reasons.push(`Seulement ${Math.round(stats.completion * 100)} % des séances réalisées : volume ramené à ce que tu tiens vraiment.`);
    } else if (stats.hardShare >= 0.5) {
      weeklyKm *= 0.9;
      reasons.push('Fatigue détectée : volume réduit de 10 %.');
    }
  }
  // Charge totale (course + futsal + arbitrage) : semaine nettement au-dessus du mois → on réduit avant la blessure.
  if (load?.zone === 'high') {
    weeklyKm *= 0.8;
    reasons.push(`Charge de la semaine trop élevée par rapport à ton mois (ratio ${String(load.ratio).replace('.', ',')}) : volume réduit de 20 % pour éviter la blessure.`);
  } else if (load?.zone === 'elevated') {
    weeklyKm *= 0.9;
    reasons.push(`Charge de la semaine élevée (ratio ${String(load.ratio).replace('.', ',')}, futsal compris) : volume réduit de 10 %.`);
  }
  if (!reasons.length) reasons.push('Rien à signaler : le plan est conservé, seules les prochaines semaines sont recalculées.');

  const startDate = addDays(mondayOf(today), 7);
  if (daysBetween(startDate, mondayOf(plan.profile.raceDate)) < 7) {
    return { plan, adjustment: { date: today, reasons: ['Trop proche de la course pour modifier le plan : on garde le cap.'] } };
  }
  const keep = plan.weeks.filter((w) => w.start < startDate);
  const profile = { ...plan.profile, weeklyKm: Math.round(weeklyKm), longestRunKm: Math.max(...keep.flatMap((w) => w.sessions).filter((s) => s.type === 'long').map((s) => s.km), 0) || plan.profile.longestRunKm };
  // Un chrono ou un test récent vaut calibrage : pas de nouveau test dans les semaines recalculées.
  if (newRace) Object.assign(profile, { recent: newRace, vmaTestDone: true });

  const fresh = generatePlan(profile, { today, startDate, vdotStart: vdot, weekOffset: keep.length ? keep.at(-1).index + 1 : 0 });
  const adjustment = { date: today, reasons, vdotBefore: cur.vdot, vdotAfter: Math.round(vdot * 10) / 10, changed: Math.abs(vdot - cur.vdot) >= 0.05 || Math.round(weeklyKm) !== Math.round(cur.volumeKm) };
  return {
    plan: {
      ...fresh,
      createdAt: plan.createdAt,
      profile,
      vdotStart: plan.vdotStart,
      warnings: fresh.warnings.filter((w) => !w.startsWith('Niveau estimé')),
      adjustments: [...(plan.adjustments ?? []), adjustment],
      weeks: [...keep, ...fresh.weeks],
    },
    adjustment,
  };
}
