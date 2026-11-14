import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vdotFromPerformance, predictTime, trainingPaces } from '../app/js/engine/vdot.js';
import { generatePlan, allocatePhases, assignDays, RACES } from '../app/js/engine/plan.js';
import { adaptPlan } from '../app/js/engine/adapt.js';

const TODAY = '2026-11-14';
const base = { raceDistance: 10000, raceDate: '2027-03-21', recent: { distanceM: 10000, timeSec: 52 * 60 }, level: 'intermediate', weeklyKm: 20, days: [1, 3, 5, 6], longRunDay: 6 };

test('VDOT : valeurs de référence de Daniels', () => {
  // 5 km en 19:57 ≈ VDOT 50 ; 10 km en 41:21 ≈ 50
  assert.ok(Math.abs(vdotFromPerformance(5000, 19 * 60 + 57) - 50) < 0.3);
  assert.ok(Math.abs(predictTime(50, 10000) - (41 * 60 + 21)) < 15);
  const p = trainingPaces(50);
  assert.ok(p.E[0] > p.M[0] && p.M[0] > p.T[0] && p.T[0] > p.I[0] && p.I[0] > p.R[0], 'zones ordonnées');
});

test('phases : affûtage en fin, compression si délai court', () => {
  const ph = allocatePhases(18, RACES[10000]);
  assert.equal(ph.length, 18);
  assert.equal(ph.at(-1), 'taper');
  const short = allocatePhases(4, RACES[42195]);
  assert.equal(short.length, 4);
  assert.equal(short[0], 'specific');
  assert.equal(short.at(-1), 'taper');
});

test('jours de qualité éloignés de la sortie longue', () => {
  const s = assignDays([1, 3, 5, 6], 6, 2);
  assert.equal(s.long, 6);
  assert.ok(!s.quality.includes(5), 'pas de séance dure la veille de la sortie longue');
});

test('plan : se termine le jour de la course, progressif', () => {
  const plan = generatePlan(base, { today: TODAY });
  const last = plan.weeks.at(-1).sessions.at(-1);
  assert.equal(last.type, 'race');
  assert.equal(last.date, base.raceDate);
  const vols = plan.weeks.filter((w) => !w.recovery && w.phase !== 'taper').map((w) => w.volumeKm);
  for (let i = 1; i < vols.length; i++) assert.ok(vols[i] <= vols[i - 1] * 1.2 + 1, `hausse trop brutale semaine ${i}`);
  for (const w of plan.weeks) for (const s of w.sessions) assert.ok(s.date >= TODAY);
  const ids = plan.weeks.flatMap((w) => w.sessions.map((s) => s.id));
  assert.equal(new Set(ids).size, ids.length, 'identifiants uniques');
});

test('plan : objectif irréaliste signalé', () => {
  const plan = generatePlan({ ...base, targetTimeSec: 40 * 60 }, { today: TODAY });
  assert.ok(plan.warnings.some((w) => w.includes('ambitieux')));
});

test('plan : toutes distances et niveaux génèrent sans erreur', () => {
  for (const d of [5000, 10000, 21097, 42195]) for (const level of ['beginner', 'intermediate', 'advanced']) {
    const plan = generatePlan({ ...base, raceDistance: d, level, recent: null, raceDate: '2027-06-13' }, { today: TODAY });
    assert.ok(plan.weeks.length > 20);
    for (const w of plan.weeks) for (const s of w.sessions) assert.ok(s.km > 0 && Number.isFinite(s.km));
  }
});

test('adaptation : fatigue → allures et volume en baisse', () => {
  const plan = generatePlan(base, { today: TODAY });
  const today = '2026-12-02';
  const log = {};
  for (const s of plan.weeks.flatMap((w) => w.sessions)) if (s.date < today) log[s.id] = { done: true, feel: 'hard' };
  const { plan: next, adjustment } = adaptPlan(plan, log, today);
  assert.ok(adjustment.vdotAfter < adjustment.vdotBefore);
  assert.equal(next.weeks.at(-1).sessions.at(-1).date, base.raceDate);
  const ids = next.weeks.flatMap((w) => w.sessions.map((s) => s.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(next.weeks.some((w) => w.start < '2026-12-07'), 'semaines passées conservées');
});

const fit = { mode: 'fitness', level: 'intermediate', weeklyKm: 12, longestRunKm: 7, recent: null, days: [1, 3, 6], longRunDay: 6 };

test('remise en forme : 3 objectifs × durées, fin par un bilan', () => {
  for (const fitnessGoal of ['restart', 'regular', 'progress']) for (const durationWeeks of [12, 16]) {
    const plan = generatePlan({ ...fit, fitnessGoal, durationWeeks }, { today: TODAY });
    assert.equal(plan.mode, 'fitness');
    assert.equal(plan.weeks.length, durationWeeks);
    const last = plan.weeks.at(-1).sessions.at(-1);
    if (fitnessGoal === 'restart') assert.match(last.title, /30 min sans/);
    else assert.equal(last.type, 'race');
    const ids = plan.weeks.flatMap((w) => w.sessions.map((s) => s.id));
    assert.equal(new Set(ids).size, ids.length);
  }
});

test('courir régulièrement : 1 seule séance de qualité par semaine', () => {
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, days: [0, 2, 4, 6] }, { today: TODAY });
  for (const w of plan.weeks.slice(0, -1)) {
    assert.ok(w.sessions.filter((s) => !['easy', 'long'].includes(s.type)).length <= 1);
  }
});

test('remise en forme : réajustement possible', () => {
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12 }, { today: TODAY });
  const { plan: next } = adaptPlan(plan, {}, '2026-12-02');
  assert.equal(next.weeks.at(-1).sessions.at(-1).date, plan.weeks.at(-1).sessions.at(-1).date);
});

test('futsal : jamais de séance dure le lendemain, affiché en facultatif', () => {
  const otherSports = [{ day: 2, kind: 'futsal' }, { day: 6, kind: 'futsal' }];
  const plan = generatePlan({ ...base, days: [0, 1, 3, 5], longRunDay: 5, otherSports }, { today: TODAY });
  const easyTypes = ['easy', 'long', 'sport', 'race'];
  for (const s of plan.weeks.flatMap((w) => w.sessions)) {
    const wd = (new Date(s.date).getUTCDay() + 6) % 7;
    if ([3, 0].includes(wd)) assert.ok(easyTypes.includes(s.type), `${s.date} ${s.title} après futsal`);
  }
  assert.ok(plan.weeks[1].sessions.some((s) => s.type === 'sport' && s.optional));
  assert.ok(plan.weeks.some((w) => w.sessions.some((s) => ['hills', 'threshold', 'intervals', 'race-pace', 'fartlek'].includes(s.type))), 'il reste de la qualité');
  assert.ok(!plan.weeks.at(-1).sessions.some((s) => s.type === 'sport'), 'pas de futsal en semaine de course');
});

test('remise en forme : 2 jours de course possibles avec futsal', () => {
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, days: [0, 4], longRunDay: 4, otherSports: [{ day: 2, kind: 'futsal' }] }, { today: TODAY });
  assert.equal(plan.weeks[1].sessions.filter((s) => !s.optional).length, 2);
  // Jour « course OU futsal » : sortie longue le dimanche malgré un futsal possible.
  const both = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, days: [1, 6], longRunDay: 6, otherSports: [{ day: 2, kind: 'futsal' }, { day: 6, kind: 'futsal' }] }, { today: TODAY });
  const sun = both.weeks[1].sessions.filter((s) => s.date === '2026-11-29');
  assert.equal(sun.length, 1, 'une seule carte le dimanche');
  assert.equal(sun[0].type, 'long');
  assert.equal(sun[0].alt, 'futsal');
  assert.throws(() => generatePlan({ ...base, days: [0, 4] }, { today: TODAY }), /3 jours/);
});

test('allure de footing → allures cohérentes (8\'30/km)', async () => {
  const { vdotFromEasyPace } = await import('../app/js/engine/vdot.js');
  const v = vdotFromEasyPace(510);
  const E = trainingPaces(v).E;
  assert.ok(E[0] < 510 && 510 < E[1], 'le footing déclaré est dans la zone Endurance');
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, easyPaceSec: 510 }, { today: TODAY });
  assert.ok(plan.weeks[0].paces.E[0] > 7 * 60 + 30, 'footing pas plus rapide que 7\'30');
});

test('déplacer une séance à aujourd\'hui : échange, conflit, footing', async () => {
  const { moveSession, downgradeToEasy, canMoveToToday } = await import('../app/js/engine/reschedule.js');
  const plan = generatePlan({ ...base, days: [1, 2, 3, 5, 6], longRunDay: 6, level: 'advanced' }, { today: TODAY });
  const w = plan.weeks.find((x) => x.phase === 'build' && !x.recovery);
  const hard = w.sessions.filter((s) => ['threshold', 'intervals'].includes(s.type));
  assert.ok(hard.length === 2);
  // Avancer la 2e séance dure à la veille de... : on la place le jour précédant la 1re pour provoquer le conflit.
  const dayBefore = new Date(hard[0].date); dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const target = dayBefore.toISOString().slice(0, 10);
  assert.ok(canMoveToToday(hard[1], {}, target) || hard[1].date > target);
  const { plan: moved, conflict } = moveSession(plan, hard[1].id, target, {});
  const ms = moved.weeks.flatMap((x) => x.sessions).find((s) => s.id === hard[1].id);
  assert.equal(ms.date, target);
  assert.equal(conflict, hard[0].id, 'conflit détecté avec la séance dure du lendemain');
  const fixed = downgradeToEasy(moved, conflict);
  assert.equal(fixed.weeks.flatMap((x) => x.sessions).find((s) => s.id === conflict).type, 'easy');
  assert.equal(plan.weeks.flatMap((x) => x.sessions).find((s) => s.id === hard[1].id).date, hard[1].date, 'plan d\'origine intact');
});

test('Garmin : course du jour, faite en avance, course libre intense', async () => {
  const { applyActivities } = await import('../app/js/engine/garminsync.js');
  const plan = generatePlan({ ...base, days: [1, 2, 3, 5, 6], longRunDay: 6, level: 'advanced' }, { today: TODAY });
  const sessions = plan.weeks.flatMap((w) => w.sessions);
  const first = sessions[0];
  const act = (id, date, km, extra = {}) => ({ id, date, start: `${date} 18:00:00`, distanceKm: km, durationSec: km * 330, paceSecPerKm: 330, ...extra });

  // 1. même jour
  let r = applyActivities(plan, {}, [act(1, first.date, first.km)], {});
  assert.equal(r.log[first.id].source, 'garmin');
  assert.equal(r.known[1], first.id);
  // relancer ne retraite pas
  const again = applyActivities(r.plan, r.log, [act(1, first.date, first.km)], r.known);
  assert.equal(again.notices.length, 0);

  // 2. en avance : course la veille d'une séance, distance proche
  const target = sessions.find((s) => s.date > '2026-11-20' && !s.optional && s.type === 'easy');
  const dayBefore = new Date(target.date); dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const db = dayBefore.toISOString().slice(0, 10);
  if (!sessions.some((s) => s.date === db && !s.optional)) {
    r = applyActivities(plan, {}, [act(2, db, target.km)], {});
    const moved = r.plan.weeks.flatMap((w) => w.sessions).find((s) => s.id === target.id);
    assert.equal(moved.date, db);
    assert.equal(moved.movedFrom, target.date);
  }

  // 3. course libre intense la veille d'une séance dure → footing
  const hard = sessions.find((s) => ['threshold', 'intervals'].includes(s.type));
  const prev = new Date(hard.date); prev.setUTCDate(prev.getUTCDate() - 1);
  const pd = prev.toISOString().slice(0, 10);
  const planNoPrev = structuredClone(plan);
  for (const w of planNoPrev.weeks) w.sessions = w.sessions.filter((s) => s.date !== pd && !(s.date > pd && s.date <= hard.date && s.id !== hard.id));
  r = applyActivities(planNoPrev, {}, [act(3, pd, 25, { trainingEffect: 4.2 })], {});
  assert.equal(r.known[3], 'free');
  assert.equal(r.plan.weeks.flatMap((w) => w.sessions).find((s) => s.id === hard.id).type, 'easy');
});

test('Garmin : futsal et arbitrage détectés automatiquement', async () => {
  const { applyActivities } = await import('../app/js/engine/garminsync.js');
  const otherSports = [{ day: 2, kind: 'futsal' }, { day: 5, kind: 'referee' }, { day: 6, kind: 'futsal' }];
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, days: [0, 3, 6], longRunDay: 6, otherSports }, { today: TODAY });
  const w = plan.weeks[1];
  const futsal = w.sessions.find((s) => s.type === 'sport' && s.sport === 'futsal');
  const referee = w.sessions.find((s) => s.type === 'sport' && s.sport === 'referee');
  const sundayRun = w.sessions.find((s) => s.alt === 'futsal');
  const acts = [
    { id: 10, date: futsal.date, start: `${futsal.date} 20:00`, type: 'indoor_soccer', durationSec: 3600, distanceKm: 0 },
    { id: 11, date: referee.date, start: `${referee.date} 15:00`, type: 'running', durationSec: 5400, distanceKm: 9.5, paceSecPerKm: 568 },
    { id: 12, date: sundayRun.date, start: `${sundayRun.date} 10:00`, type: 'soccer', durationSec: 3000, distanceKm: 0 },
  ];
  const r = applyActivities(plan, {}, acts, {});
  assert.equal(r.log[futsal.id].done, true);
  assert.equal(r.log[referee.id].done, true, 'course un jour d\'arbitrage = arbitrage');
  assert.equal(r.log[sundayRun.id].replacedBy, 'futsal');
  assert.equal(r.freeRuns.length, 0);
});

test('coach : cœur trop haut sur les footings → allures ralenties ; cœur bas et allure tenue → relevées', async () => {
  const { dataSignals } = await import('../app/js/engine/coach.js');
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, easyPaceSec: 510, days: [0, 3, 6], longRunDay: 6 }, { today: TODAY });
  const today = '2026-12-01';
  const easy = plan.weeks.flatMap((w) => w.sessions).filter((s) => ['easy', 'long'].includes(s.type) && s.date < today && s.date >= '2026-11-17');
  assert.ok(easy.length >= 3);
  const hr = { maxHr: 190, restHr: 60 };
  const mk = (avgHr, pace) => Object.fromEntries(easy.map((s) => [s.id, { done: true, source: 'garmin', paceSecPerKm: pace, avgHr }]));
  const tooHigh = dataSignals(plan, mk(175, 520), today, hr); // réserve ≈ 88 %
  assert.ok(tooHigh.deltaVdot < 0);
  const fitter = dataSignals(plan, mk(135, 490), today, hr); // réserve ≈ 58 %, plus vite que le milieu de zone
  assert.ok(fitter.deltaVdot > 0);
  const noHr = dataSignals(plan, mk(undefined, 400), today, null);
  assert.equal(noHr.deltaVdot, 0);
  assert.ok(noHr.reasons.some((r) => r.includes('ralentis')));
  // Intégration : le réajustement applique le signal
  const { plan: next, adjustment } = adaptPlan(plan, mk(175, 520), today, null, hr);
  assert.ok(adjustment.vdotAfter < adjustment.vdotBefore);
  assert.ok(next.weeks.at(-1).paces.E[0] > plan.weeks.at(-1).paces.E[0], 'footings plus lents en fin de plan');
});
