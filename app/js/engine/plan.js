// Générateur de plan d'entraînement progressif.
//
// Principes appliqués (consensus de l'entraînement en course à pied) :
//  - Périodisation inversée depuis la date de course : Fondation → Développement → Spécifique → Affûtage.
//  - Volume en hausse progressive (~+7 %/semaine max), avec semaine allégée toutes les 4 semaines (cycle 3:1).
//  - ~80 % du volume en endurance fondamentale, 1 à 2 séances de qualité par semaine selon le niveau.
//  - Allures calculées par le modèle VDOT à partir d'une performance récente.

import { vdotFromPerformance, vdotFromEasyPace, predictTime, racePace, trainingPaces } from './vdot.js';
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
  restart: { label: 'Reprise', goal: 'Alterner marche et course pour habituer le corps en douceur.' },
};

export const SPORTS = {
  futsal: { label: 'Futsal', icon: '⚽', description: 'Séance intense (sprints, changements de direction) : elle compte comme ta séance de fractionné de la semaine.' },
  referee: { label: 'Arbitrage', icon: '🏁', description: 'Match arbitré : 8 à 12 km avec accélérations, une vraie charge d\'entraînement.' },
};

/** Activités hors course à pied (facultatives) pour une semaine. */
function sportSessions(sports, weekStart, today, weekIdx, skipDays = []) {
  const out = [];
  for (const { day, kind } of sports) {
    if (skipDays.includes(day)) continue;
    const date = addDays(weekStart, day);
    if (daysBetween(today, date) < 0) continue;
    const sp = SPORTS[kind];
    out.push({
      id: `${weekIdx}-${day}-${kind}`, date, type: 'sport', sport: kind, optional: true,
      title: `${sp.label} (si tu y vas)`, description: sp.description, steps: [], km: 0, min: 0,
    });
  }
  return out;
}

export const FITNESS_GOALS = {
  restart: { label: 'Reprendre la course', end: 'Courir 30 min sans s\'arrêter' },
  regular: { label: 'Courir régulièrement', end: 'Installer une routine et un volume stable' },
  progress: { label: 'Progresser', end: 'Améliorer ton chrono sur 5 km' },
};

/** Début du plan : lundi de cette semaine si on est en début de semaine, sinon lundi prochain. */
export function planStart(today) {
  return weekday(today) <= 2 ? mondayOf(today) : addDays(mondayOf(today), 7);
}

/** Phases d'un cycle « courir régulièrement » : fondation puis développement léger, dernière semaine allégée. */
function regularPhases(n) {
  const base = Math.max(1, Math.round((n - 1) * 0.6));
  return [...Array(base).fill('base'), ...Array(Math.max(0, n - 1 - base)).fill('build'), 'taper'];
}

// Valeurs prudentes quand on ne sait rien : mieux vaut un footing trop lent que trop rapide.
const DEFAULT_VDOT = { beginner: 26, intermediate: 32, advanced: 40 };
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
function qualityPlan(phase, level, idxInPhase, nSessions, recovery, distance, light = false) {
  let q;
  if (light && phase === 'build') return recovery ? ['fartlek'] : [idxInPhase % 2 ? 'fartlek' : 'threshold'];
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
export function assignDays(days, longDay, nQuality, sportDays = []) {
  const quality = [];
  const candidates = days.filter((d) => d !== longDay);
  // Jamais de séance dure un jour de sport possible ni le lendemain (futsal, arbitrage) ; la veille est évitée si possible (score).
  const allowed = candidates.filter((d) => !sportDays.includes(d) && !sportDays.some((sd) => (d - sd + 7) % 7 === 1));
  for (let k = 0; k < nQuality; k++) {
    let best = null, bestScore = -1;
    for (const d of allowed) {
      if (quality.includes(d)) continue;
      const score = Math.min(...[longDay, ...quality, ...sportDays].map((o) => circDist(d, o)));
      if (score > bestScore) { bestScore = score; best = d; }
    }
    if (best == null) break; // aucun jour sûr : la séance dure est remplacée par un footing
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
  const fitness = profile.mode === 'fitness';
  if (fitness && profile.fitnessGoal === 'restart') return generateRestartPlan(profile, opts);
  if (fitness) {
    // Un cycle de forme = une préparation « 5 km » sans pression, conclue par un test chrono.
    profile = { ...profile, raceDistance: 5000, targetTimeSec: null };
    if (!profile.raceDate) {
      profile.raceDate = addDays(opts.startDate ?? planStart(today), (profile.durationWeeks - 1) * 7 + profile.longRunDay);
    }
  }
  const regular = fitness && profile.fitnessGoal === 'regular';
  const race = RACES[profile.raceDistance];
  if (!race) throw new Error('Distance de course non supportée.');
  const level = profile.level;
  const days = [...profile.days].sort((a, b) => a - b);
  const nSessions = days.length;
  const sports = profile.otherSports ?? [];
  const sportDays = [...new Set(sports.map((x) => x.day))];
  if (nSessions < (fitness ? 2 : 3)) throw new Error(`Il faut au moins ${fitness ? 2 : 3} jours de course par semaine.`);
  if (!days.includes(profile.longRunDay)) throw new Error('Le jour de sortie longue doit faire partie des jours choisis.');

  // Début : lundi de cette semaine si on est en début de semaine, sinon lundi prochain.
  const start = opts.startDate ?? planStart(today);
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
    } else if (profile.easyPaceSec) {
      vdotStart = vdotFromEasyPace(profile.easyPaceSec);
      warnings.push('Allures calculées à partir de ton allure de footing. Un chrono (test 5 km) les rendra plus précises.');
    } else {
      vdotStart = DEFAULT_VDOT[level];
      warnings.push(fitness
        ? 'Niveau estimé sans chrono de référence : les allures seront recalibrées avec le test 5 km de fin de cycle (ou ajoute un chrono dans Profil).'
        : 'Niveau estimé sans chrono de référence : fais un test (5 km à fond) dans les 2 premières semaines puis réajuste le plan.');
    }
  }

  const phases = regular ? regularPhases(nWeeks) : allocatePhases(nWeeks, race);
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
  let peak = Math.max(Math.min(race.peak[level], sessionCap), Math.min(startVolume, sessionCap));
  // Routine : on stabilise un volume raisonnable plutôt que de viser un pic.
  if (regular) peak = Math.min(peak, Math.max(startVolume * 1.4, startVolume + 10));
  const phaseCap = { base: 0.85 * peak, build: 0.95 * peak, specific: peak };
  if ((profile.weeklyKm || 0) < 10 && profile.raceDistance >= 21097) {
    warnings.push('Volume actuel faible pour cette distance : la progression sera prudente, écoute les signaux de douleur.');
  }

  const longFrac = nSessions <= 2 ? 0.45 : nSessions === 3 ? 0.36 : nSessions === 4 ? 0.32 : 0.28;
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
      const alt = sports.find((x) => x.day === dayIdx)?.kind;
      sessions.push({ id: `${weekOffset + i}-${dayIdx}`, date, ...s, km: est.km, min: est.min, ...(alt && !isRaceWeek ? { alt } : {}) });
    };

    if (isRaceWeek) {
      const raceWd = weekday(profile.raceDate);
      const restBefore = profile.raceDistance >= 21097 ? 1 : 0;
      const pre = days.filter((d) => d < raceWd - restBefore).slice(-3);
      const sharpDay = pre.find((d) => raceWd - d >= 2);
      for (const d of pre) {
        if (d === sharpDay && !regular) push(d, W.sharpener(c));
        else push(d, W.easyRun(c, clamp(volume * 0.15, 3, 7), { strides: d === pre[pre.length - 1] }));
      }
      const goalText = formatDuration(predictTime(vdotGoal, profile.raceDistance));
      push(raceWd, fitness ? W.testRun(c, regular) : W.raceDay(c, race.label, goalText));
    } else {
      let qTypes = qualityPlan(phase, level, idxInPhase, nSessions, recovery, profile.raceDistance, regular);
      // Le futsal/arbitrage apporte déjà de l'intensité : une séance dure de moins (aucune en mode « régulier »).
      if (sportDays.length) qTypes = regular ? [] : qTypes.slice(0, Math.max(1, qTypes.length - 1));
      const slots = assignDays(days, profile.longRunDay, qTypes.length, sportDays);
      qTypes = qTypes.slice(0, slots.quality.length);
      // Un jour à la fois « course » et « sport possible » : une seule carte « séance OU sport ».
      sessions.push(...sportSessions(sports, weekStart, today, weekOffset + i, days));

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
    if (!recovery && phase !== 'taper' && sessions.filter((x) => !x.optional).length === nSessions) load = Math.max(load, Math.min(actualKm, peak));
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
    mode: fitness ? 'fitness' : 'race',
    createdAt: today,
    profile,
    raceLabel: fitness ? FITNESS_GOALS[profile.fitnessGoal].label : race.label,
    goalText: fitness ? FITNESS_GOALS[profile.fitnessGoal].end : null,
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

// ---------- Reprise : alternance marche / course ----------

// [course (s), marche (s), répétitions] — progression inspirée des programmes de reprise classiques.
const RUN_WALK = [
  [60, 120, 8], [90, 120, 7], [120, 120, 6], [180, 120, 5], [240, 90, 5], [300, 90, 4],
  [480, 120, 3], [600, 120, 3], [720, 90, 2], [1200, 0, 1], [1500, 0, 1], [1800, 0, 1],
];

function generateRestartPlan(profile, opts) {
  const { today } = opts;
  const start = opts.startDate ?? planStart(today);
  const nWeeks = profile.durationWeeks;
  const days = [...profile.days].sort((a, b) => a - b);
  const sports = profile.otherSports ?? [];
  if (days.length < 3) throw new Error('Il faut au moins 3 jours par semaine.');
  // 3 séances suffisent en reprise : on garde des jours espacés.
  const longDay = days.includes(profile.longRunDay) ? profile.longRunDay : days.at(-1);
  const slots = days.length > 3 ? [longDay, ...assignDays(days, longDay, 2).quality].sort((a, b) => a - b) : days;
  const vdot = opts.vdotStart ?? DEFAULT_VDOT.beginner;
  const paces = trainingPaces(vdot);
  const c = { paces };
  const weekOffset = opts.weekOffset ?? 0;

  const weeks = [];
  for (let i = 0; i < nWeeks; i++) {
    // Progression régulière dans le tableau ; toutes les 4 semaines on consolide (même palier).
    // Les 3 dernières semaines sont toujours 20 → 25 → 30 min continues ; avant, on répartit l'alternance.
    const nAlt = RUN_WALK.length - 3, weeksAlt = nWeeks - 3;
    const altIdx = (k) => (weeksAlt > 1 ? Math.round((k / (weeksAlt - 1)) * (nAlt - 1)) : nAlt - 1);
    let idx = i >= weeksAlt ? nAlt + (i - weeksAlt) : altIdx(i);
    if (i < weeksAlt && i % 4 === 3) idx = altIdx(i - 1); // semaine de consolidation
    const [run, walk, reps] = RUN_WALK[idx];
    const weekStart = addDays(start, i * 7);
    const sessions = [];
    slots.forEach((d, k) => {
      const date = addDays(weekStart, d);
      if (daysBetween(today, date) < 0) return;
      const final = i === nWeeks - 1 && k === slots.length - 1;
      const s = W.runWalk(c, run, walk, reps, final);
      const est = W.estimate(s.steps, paces);
      const alt = sports.find((x) => x.day === d)?.kind;
      sessions.push({ id: `${weekOffset + i}-${d}`, date, ...s, km: est.km, min: est.min, ...(alt ? { alt } : {}) });
    });
    sessions.push(...sportSessions(sports, weekStart, today, weekOffset + i, slots));
    sessions.sort((a, b) => a.date.localeCompare(b.date));
    weeks.push({
      index: weekOffset + i, start: weekStart, phase: 'restart', recovery: i < nWeeks - 3 && i % 4 === 3, raceWeek: false,
      volumeKm: Math.round(sessions.reduce((a, x) => a + x.km, 0) * 10) / 10, vdot, paces, sessions,
    });
  }
  const end = addDays(start, (nWeeks - 1) * 7 + slots.at(-1));
  return {
    version: 1,
    mode: 'fitness',
    createdAt: today,
    profile: { ...profile, level: 'beginner', raceDate: end, raceDistance: 5000 },
    raceLabel: FITNESS_GOALS.restart.label,
    goalText: FITNESS_GOALS.restart.end,
    vdotStart: vdot, vdotGoal: vdot,
    predictedNowSec: null, predictedGoalSec: null, racePace: null,
    warnings: ['Douleur articulaire ou tendineuse qui persiste plus de 2 jours : répète la semaine précédente au lieu d\'avancer.'],
    adjustments: [],
    weeks,
  };
}
