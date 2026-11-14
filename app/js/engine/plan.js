// Générateur de plan d'entraînement progressif.
//
// Principes appliqués (consensus de l'entraînement en course à pied) :
//  - Périodisation inversée depuis la date de course : Fondation → Développement → Spécifique → Affûtage.
//  - Volume en hausse progressive (~+7 %/semaine max), avec semaine allégée toutes les 4 semaines (cycle 3:1).
//  - ~80 % du volume en endurance fondamentale, 1 à 2 séances de qualité par semaine selon le niveau.
//  - Allures calculées par le modèle VDOT à partir d'une performance récente.

import { vdotFromPerformance, predictTime, racePace, trainingPaces } from './vdot.js';
import { addDays, mondayOf, weekday, daysBetween } from './dates.js';
import * as W from './workouts.js';

export const RACES = {
  5000: { label: '5 km', taper: [0.55], specific: 5, build: 4,
    longCap: { beginner: 12, intermediate: 14, advanced: 16 }, peak: { beginner: 25, intermediate: 35, advanced: 50 } },
  10000: { label: '10 km', taper: [0.55], specific: 6, build: 5,
    longCap: { beginner: 14, intermediate: 17, advanced: 19 }, peak: { beginner: 30, intermediate: 42, advanced: 58 } },
  21097: { label: 'Semi-marathon', taper: [0.7, 0.45], specific: 6, build: 6,
    longCap: { beginner: 18, intermediate: 21, advanced: 24 }, peak: { beginner: 35, intermediate: 50, advanced: 70 } },
  42195: { label: 'Marathon', taper: [0.75, 0.6, 0.4], specific: 8, build: 6,
    longCap: { beginner: 30, intermediate: 32, advanced: 34 }, peak: { beginner: 45, intermediate: 62, advanced: 85 } },
};

export const PHASES = {
  base: { label: 'Fondation', goal: "Construire l'endurance et la solidité (tendons, articulations)." },
  build: { label: 'Développement', goal: 'Élever le seuil et la VMA, monter le volume.' },
  specific: { label: 'Spécifique', goal: "Travailler l'allure exacte de la course." },
  taper: { label: 'Affûtage', goal: 'Réduire le volume, garder l\'intensité : arriver frais le jour J.' },
};

const DEFAULT_VDOT = { beginner: 30, intermediate: 38, advanced: 46 };
// Gain de VDOT réaliste par semaine d'entraînement, et plafond sur un cycle.
const GAIN_RATE = { beginner: 0.25, intermediate: 0.15, advanced: 0.08 };
const GAIN_CAP = { beginner: 8, intermediate: 5, advanced: 3 };
const KM_PER_SESSION = { beginner: 10, intermediate: 12, advanced: 14 };

const round05 = (x) => Math.round(x * 2) / 2;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const circDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 7 - d); };

export function formatDuration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}'${String(s).padStart(2, '0')}` : `${m}'${String(s).padStart(2, '0')}`;
}

/** Répartit les semaines en phases, en partant de la date de course. */
export function allocatePhases(nWeeks, race) {
  let taper = race.taper.length, spec = race.specific, build = race.build;
  let base = nWeeks - taper - spec - build;
  if (base < 0) {
    let deficit = -base; base = 0;
    const cut = (x, min) => { const c = Math.min(deficit, Math.max(0, x - min)); deficit -= c; return x - c; };
    build = cut(build, 0); spec = cut(spec, 2); taper = cut(taper, 1);
  }
  return [
    ...Array(base).fill('base'), ...Array(build).fill('build'),
    ...Array(spec).fill('specific'), ...Array(taper).fill('taper'),
  ];
}

/** Types de séances de qualité pour une semaine. */
function qualityPlan(phase, level, idxInPhase, nSessions, recovery, distance) {
  let q;
  if (phase === 'base') {
    const alt = idxInPhase % 2 ? 'fartlek' : 'hills';
    q = level === 'beginner' ? [] : level === 'advanced' && nSessions >= 5 ? [alt, 'threshold'] : [alt];
  } else if (phase === 'build') {
    q = level === 'beginner' ? [idxInPhase % 2 ? 'threshold' : 'fartlek'] : ['threshold', 'intervals'];
  } else if (phase === 'specific') {
    q = level === 'beginner' ? ['race-pace'] : ['race-pace', distance >= 21097 ? 'threshold' : 'intervals'];
  } else {
    q = ['race-pace'];
  }
  if (recovery) q = level === 'beginner' ? [] : q.slice(0, 1);
  return q.slice(0, Math.max(0, nSessions - 2));
}

/** Choisit les jours des séances de qualité : le plus loin possible de la sortie longue et entre elles. */
export function assignDays(days, longDay, nQuality) {
  const quality = [];
  const candidates = days.filter((d) => d !== longDay);
  for (let k = 0; k < nQuality && candidates.length; k++) {
    let best = null, bestScore = -1;
    for (const d of candidates) {
      if (quality.includes(d)) continue;
      const score = Math.min(...[longDay, ...quality].map((o) => circDist(d, o)));
      if (score > bestScore) { bestScore = score; best = d; }
    }
    quality.push(best);
  }
  quality.sort((a, b) => a - b);
  const easy = candidates.filter((d) => !quality.includes(d));
  return { long: longDay, quality, easy };
}

function buildQuality(type, c, p) {
  switch (type) {
    case 'hills': return W.hills(c, p);
    case 'fartlek': return W.fartlek(c, p);
    case 'threshold': return W.threshold(c, p);
    case 'intervals': return W.intervals(c, p);
    case 'race-pace': return W.raceSpecific(c, p);
    default: throw new Error(`Type inconnu ${type}`);
  }
}

/**
 * Génère un plan.
 * @param profile Réponses au questionnaire.
 * @param opts { today, startDate?, vdotStart?, weekOffset? } — les options servent au réajustement.
 */
export function generatePlan(profile, opts) {
  const { today } = opts;
  const race = RACES[profile.raceDistance];
  if (!race) throw new Error('Distance de course non supportée.');
  const level = profile.level;
  const days = [...profile.days].sort((a, b) => a - b);
  const nSessions = days.length;
  if (nSessions < 3) throw new Error('Il faut au moins 3 jours de course par semaine.');
  if (!days.includes(profile.longRunDay)) throw new Error('Le jour de sortie longue doit faire partie des jours choisis.');

  // Début : lundi de cette semaine si on est en début de semaine, sinon lundi prochain.
  const start = opts.startDate ?? (weekday(today) <= 2 ? mondayOf(today) : addDays(mondayOf(today), 7));
  const raceMonday = mondayOf(profile.raceDate);
  const nWeeks = daysBetween(start, raceMonday) / 7 + 1;
  if (daysBetween(today, profile.raceDate) < 0) throw new Error('La date de course est passée.');
  if (nWeeks < 3) throw new Error('La course est trop proche (moins de 3 semaines) pour construire un plan.');

  const warnings = [];

  // --- Niveau (VDOT) ---
  let vdotStart = opts.vdotStart;
  if (vdotStart == null) {
    if (profile.recent?.distanceM && profile.recent?.timeSec) {
      vdotStart = vdotFromPerformance(profile.recent.distanceM, profile.recent.timeSec);
    } else {
      vdotStart = DEFAULT_VDOT[level];
      warnings.push("Niveau estimé sans chrono de référence : fais un test (5 km à fond) dans les 2 premières semaines puis réajuste le plan.");
    }
  }

  const phases = allocatePhases(nWeeks, race);
  const trainingWeeks = phases.filter((p) => p !== 'taper').length;
  const maxGain = Math.min(GAIN_CAP[level], GAIN_RATE[level] * trainingWeeks);
  const targetVdot = profile.targetTimeSec ? vdotFromPerformance(profile.raceDistance, profile.targetTimeSec) : null;
  let gain;
  if (targetVdot != null) {
    gain = Math.min(targetVdot - vdotStart, maxGain);
    if (targetVdot - vdotStart > maxGain + 0.05) {
      const realistic = predictTime(vdotStart + maxGain, profile.raceDistance);
      warnings.push(`Objectif ${formatDuration(profile.targetTimeSec)} ambitieux : ton niveau actuel prédit ${formatDuration(predictTime(vdotStart, profile.raceDistance))}, et ${formatDuration(realistic)} semble atteignable en ${trainingWeeks} semaines. Le plan vise ${formatDuration(realistic)} ; on réévaluera en cours de route.`);
    }
  } else {
    gain = maxGain * 0.6;
  }
  // Un objectif plus lent que le niveau actuel est respecté (allure course), sans ralentir les allures d'entraînement.
  const paceGain = Math.max(0, gain);
  const vdotGoal = vdotStart + gain;
  const rp = racePace(vdotGoal, profile.raceDistance);
  const racePaceRange = [rp - 2, rp + 2];

  // --- Volume ---
  const sessionCap = nSessions * KM_PER_SESSION[level];
  const startVolume = Math.max(profile.weeklyKm || 0, nSessions * 4);
  const peak = Math.max(Math.min(race.peak[level], sessionCap), Math.min(startVolume, sessionCap));
  const phaseCap = { base: 0.85 * peak, build: 0.95 * peak, specific: peak };
  if ((profile.weeklyKm || 0) < 10 && profile.raceDistance >= 21097) {
    warnings.push('Volume actuel faible pour cette distance : la progression sera prudente, écoute les signaux de douleur.');
  }

  const longFrac = nSessions <= 3 ? 0.36 : nSessions === 4 ? 0.32 : 0.28;
  const minEasy = level === 'beginner' ? 3 : 5;
  const weekOffset = opts.weekOffset ?? 0;

  let load = startVolume;
  const longCap = race.longCap[level];
  const longStart = Math.min(longCap, profile.longestRunKm || startVolume * longFrac);
  let prevLong = longStart;
  const weeks = [];
  const phaseCounters = {};
  let taperIdx = 0;

  for (let i = 0; i < nWeeks; i++) {
    const phase = phases[i];
    const idxInPhase = (phaseCounters[phase] = (phaseCounters[phase] ?? -1) + 1);
    const phaseLen = phases.filter((p) => p === phase).length;
    const p = phaseLen > 1 ? idxInPhase / (phaseLen - 1) : 1;
    const isRaceWeek = i === nWeeks - 1;
    const recovery = phase !== 'taper' && i % 4 === 3;
    const weekStart = addDays(start, i * 7);

    // Volume de la semaine
    let volume;
    if (phase === 'taper') {
      volume = peak * race.taper[Math.min(taperIdx++, race.taper.length - 1) + (race.taper.length - phaseLen)];
    } else {
      // Pas de hausse pendant une semaine allégée : la progression reprend ensuite.
      if (i > 0 && !recovery) load = Math.min(load * 1.07 + 0.5, Math.max(phaseCap[phase], load));
      volume = recovery ? load * 0.75 : load;
    }
    volume = round05(volume);

    // Allures : progression par paliers de 4 semaines vers le VDOT objectif
    const vdotWeek = vdotStart + paceGain * Math.min(1, Math.floor(i / 4) * 4 / Math.max(1, trainingWeeks - 1));
    const c = { paces: trainingPaces(vdotWeek), racePaceRange, raceDistance: profile.raceDistance };

    const sessions = [];
    const push = (dayIdx, s) => {
      const date = addDays(weekStart, dayIdx);
      if (daysBetween(today, date) < 0) return; // jours déjà passés
      const est = W.estimate(s.steps, c.paces);
      sessions.push({ id: `${weekOffset + i}-${dayIdx}`, date, ...s, km: est.km, min: est.min });
    };

    if (isRaceWeek) {
      const raceWd = weekday(profile.raceDate);
      const restBefore = profile.raceDistance >= 21097 ? 1 : 0;
      const pre = days.filter((d) => d < raceWd - restBefore).slice(-3);
      const sharpDay = pre.find((d) => raceWd - d >= 2);
      for (const d of pre) {
        if (d === sharpDay) push(d, W.sharpener(c));
        else push(d, W.easyRun(c, clamp(volume * 0.15, 3, 7), { strides: d === pre[pre.length - 1] }));
      }
      const goalText = formatDuration(predictTime(vdotGoal, profile.raceDistance));
      push(raceWd, W.raceDay(c, race.label, goalText));
    } else {
      let qTypes = qualityPlan(phase, level, idxInPhase, nSessions, recovery, profile.raceDistance);
      const slots = assignDays(days, profile.longRunDay, qTypes.length);

      // Sortie longue
      // Rampe progressive vers la sortie longue maximale (fonction de la distance), bornée par
      // +2 km/semaine, 50 % du volume hebdo et réduite en semaine allégée / affûtage.
      let longKm;
      if (phase === 'taper') {
        longKm = Math.min(volume * longFrac, longCap * 0.6);
      } else {
        const progress = Math.min(1, i / Math.max(1, trainingWeeks - 2));
        const ramp = longStart + (longCap - longStart) * progress;
        longKm = Math.min(longCap, Math.max(volume * longFrac, ramp), volume * 0.5, prevLong + 2);
        if (recovery) longKm *= 0.75; else prevLong = Math.max(prevLong, longKm);
      }
      longKm = round05(Math.max(longKm, level === 'beginner' ? 5 : 6));
      let longOpts = {};
      if (phase === 'specific' && !recovery && idxInPhase % 2 === 1) {
        if (profile.raceDistance === 42195) longOpts = { finishZone: 'M', finishKm: Math.round(6 + p * 8) };
        if (profile.raceDistance === 21097) longOpts = { finishZone: 'race', finishKm: Math.round(3 + p * 4) };
        if (longOpts.finishKm) longOpts.finishKm = Math.min(longOpts.finishKm, Math.floor(longKm / 2));
      }
      const long = W.longRun(c, longKm, longOpts);

      let pQ = recovery ? Math.max(0, p - 0.3) : phase === 'taper' ? 0.3 : p;
      if (level === 'beginner') pQ *= 0.5; // séances plus courtes pour un débutant
      const quality = qTypes.map((t) => buildQuality(t, c, pQ));
      const qualityKm = quality.reduce((s, q) => s + W.estimate(q.steps, c.paces).km, 0);

      const nEasy = slots.easy.length;
      const easyKm = nEasy ? clamp((volume - longKm - qualityKm) / nEasy, minEasy, Math.max(minEasy, longKm * 0.75)) : 0;
      const stridesOn = phase === 'base' || phase === 'build' ? slots.easy[0] : null;

      push(slots.long, long);
      slots.quality.forEach((d, k) => push(d, quality[k]));
      // Les lignes droites ajoutent ~1 km : on raccourcit d'autant le footing concerné.
      slots.easy.forEach((d) => push(d, d === stridesOn
        ? W.easyRun(c, Math.max(minEasy - 1, easyKm - 1), { strides: true })
        : W.easyRun(c, easyKm)));
    }

    sessions.sort((a, b) => a.date.localeCompare(b.date));
    const actualKm = sessions.reduce((s, x) => s + x.km, 0);
    // Les minimums (footing, échauffements) peuvent dépasser la cible : on repart du réel.
    if (!recovery && phase !== 'taper' && sessions.length === nSessions) load = Math.max(load, Math.min(actualKm, peak));
    weeks.push({
      index: weekOffset + i,
      start: weekStart,
      phase,
      recovery,
      raceWeek: isRaceWeek,
      volumeKm: Math.round(actualKm * 10) / 10,
      vdot: Math.round(vdotWeek * 10) / 10,
      paces: c.paces,
      sessions,
    });
  }

  return {
    version: 1,
    createdAt: today,
    profile,
    raceLabel: race.label,
    vdotStart: Math.round(vdotStart * 10) / 10,
    vdotGoal: Math.round(vdotGoal * 10) / 10,
    predictedNowSec: predictTime(vdotStart, profile.raceDistance),
    predictedGoalSec: predictTime(vdotGoal, profile.raceDistance),
    racePace: rp,
    warnings,
    adjustments: [],
    weeks,
  };
}
