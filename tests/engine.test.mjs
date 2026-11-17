import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vdotFromPerformance, predictTime, trainingPaces } from '../app/js/engine/vdot.js';
import { generatePlan, allocatePhases, assignDays, RACES } from '../app/js/engine/plan.js';
import { applyActivities } from '../app/js/engine/garminsync.js';
import { moveSession, addBonus, canAddBonus } from '../app/js/engine/reschedule.js';
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
    for (const w of plan.weeks) for (const s of w.sessions.filter((x) => x.type !== 'strength')) assert.ok(s.km > 0 && Number.isFinite(s.km));
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
    assert.ok(w.sessions.filter((s) => !['easy', 'long', 'strength'].includes(s.type)).length <= 1);
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
  const easyTypes = ['easy', 'long', 'sport', 'race', 'strength'];
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

test('test 6 min : fin de Fondation en remise en forme, semaine 2 en prépa sans chrono, absent sinon', () => {
  const tests = (plan) => plan.weeks.flatMap((w) => w.sessions.filter((s) => s.type === 'test').map(() => w));
  const reg = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, days: [1, 3, 6], longRunDay: 6, otherSports: [{ day: 2, kind: 'futsal' }, { day: 6, kind: 'futsal' }] }, { today: TODAY });
  const t1 = tests(reg);
  assert.equal(t1.length, 1);
  assert.equal(t1[0].phase, 'base');
  assert.equal(reg.weeks[t1[0].index + 1].phase, 'build', 'juste avant le Développement');
  const testSession = reg.weeks[t1[0].index].sessions.find((s) => s.type === 'test');
  const wd = (new Date(testSession.date).getUTCDay() + 6) % 7;
  assert.ok(![2, 3, 6, 0].includes(wd), 'ni un jour de futsal ni le lendemain');
  const raceNoChrono = generatePlan({ ...base, recent: null }, { today: TODAY });
  assert.equal(tests(raceNoChrono)[0]?.index, 1);
  assert.equal(tests(generatePlan(base, { today: TODAY })).length, 0, 'chrono connu : pas de test en début de prépa');
  // Après le test : recalibrage, et plus de nouveau test dans les semaines recalculées
  const { plan: next } = adaptPlan(reg, {}, testSession.date, { distanceM: 1250, timeSec: 360 });
  assert.equal(next.profile.vmaTestDone, true);
  assert.equal(next.weeks.filter((w) => w.start > testSession.date).flatMap((w) => w.sessions).filter((s) => s.type === 'test').length, 0);
});

test('test court très au-dessus du niveau : hausse plafonnée à +3', () => {
  const reg = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, easyPaceSec: 510 }, { today: TODAY });
  const { adjustment } = adaptPlan(reg, {}, '2026-12-29', { distanceM: 1250, timeSec: 360 });
  assert.ok(Math.abs(adjustment.vdotAfter - adjustment.vdotBefore - 3) < 0.15);
  assert.ok(adjustment.reasons.some((r) => r.includes('12,5 km/h')));
  // Un chrono long (10 km) n'est pas plafonné
  const { adjustment: a2 } = adaptPlan(reg, {}, '2026-12-29', { distanceM: 10000, timeSec: 52 * 60 });
  assert.ok(a2.vdotAfter - a2.vdotBefore > 3);
});

test('analyse : répétitions lues tour par tour, verdict et ajustement de la séance suivante', async () => {
  const { analyzeSession, applyVerdict, flattenSteps } = await import('../app/js/engine/analysis.js');
  const plan = generatePlan({ ...base, level: 'advanced', days: [1, 2, 3, 5, 6], longRunDay: 6 }, { today: TODAY });
  const all = plan.weeks.flatMap((w) => w.sessions);
  const thr = all.filter((s) => s.type === 'threshold');
  const s = thr[2];
  const week = plan.weeks.find((w) => w.sessions.includes(s));
  const flat = flattenSteps(s.steps);
  const lapsFor = (offset) => flat.map((st) => {
    const pace = st.pace ? (st.pace[0] + st.pace[1]) / 2 + (st.kind === 'run' && st.zone === 'T' ? offset : 0) : 420;
    const durationSec = st.dur.type === 'time' ? st.dur.s : (st.dur.m / 1000) * pace;
    return { durationSec, distanceM: st.dur.type === 'distance' ? st.dur.m : (durationSec / pace) * 1000, avgHr: 150 };
  });
  // Dans la cible → réussie
  assert.equal(analyzeSession(s, { feel: 'ok' }, lapsFor(0), week.paces).verdict, 'success');
  // 15 s/km trop lent sur toutes les répétitions → trop dure, la suivante ne progresse pas
  const hard = analyzeSession(s, { feel: 'hard' }, lapsFor(15), week.paces);
  assert.equal(hard.verdict, 'hard');
  const next = thr.find((x) => x.date > s.date);
  const r = applyVerdict(plan, {}, s.id, 'hard');
  const adjusted = r.plan.weeks.flatMap((w) => w.sessions).find((x) => x.id === next.id);
  assert.ok(adjusted.level <= s.level, 'pas de progression après une séance ratée');
  // Plus vite que la cible + ressenti facile → trop facile, la suivante progresse
  assert.equal(analyzeSession(s, { feel: 'easy' }, lapsFor(-15), week.paces).verdict, 'easy');
  const r2 = applyVerdict(plan, {}, s.id, 'easy');
  assert.ok(r2.plan.weeks.flatMap((w) => w.sessions).find((x) => x.id === next.id).level > next.level);
  // Sans tours : ressenti
  assert.equal(analyzeSession(s, { feel: 'hard' }, null, week.paces).source, 'feel');
});

test('analyse : footing trop rapide et dérive cardiaque de la sortie longue', async () => {
  const { analyzeSession } = await import('../app/js/engine/analysis.js');
  const plan = generatePlan(base, { today: TODAY });
  const w = plan.weeks[3];
  const easy = w.sessions.find((s) => s.type === 'easy');
  assert.equal(analyzeSession(easy, { feel: 'ok', paceSecPerKm: w.paces.E[0] - 30 }, null, w.paces).verdict, 'fast');
  const long = w.sessions.find((s) => s.type === 'long');
  const laps = [140, 142, 150, 158].map((hr) => ({ distanceM: 1000, durationSec: 400, avgHr: hr }));
  const res = analyzeSession(long, { feel: 'ok', paceSecPerKm: (w.paces.E[0] + w.paces.E[1]) / 2 }, laps, w.paces);
  assert.ok(res.details.some((d) => d.includes('Dérive cardiaque de')));
});

test('charge : ratio aigu/chronique, futsal compris, et réduction du volume', async () => {
  const { loadStatus, activityLoad } = await import('../app/js/engine/load.js');
  const t = '2026-12-20';
  const act = (date, load) => ({ date, trainingLoad: load, durationSec: 3600 });
  const steady = [];
  for (let d = 27; d >= 1; d -= 2) { const x = new Date('2026-12-20'); x.setUTCDate(x.getUTCDate() - d); steady.push(act(x.toISOString().slice(0, 10), 60)); }
  assert.equal(loadStatus(steady, t).zone, 'optimal');
  const spike = [...steady, act('2026-12-18', 250), act('2026-12-19', 250), act('2026-12-20', 200)];
  const st = loadStatus(spike, t);
  assert.equal(st.zone, 'high');
  assert.equal(loadStatus([act('2026-12-19', 50)], t).ratio, null, 'pas assez d\'historique');
  // TRIMP sans charge Garmin : plus intense = plus de charge
  const hr = { maxHr: 190, restHr: 60 };
  assert.ok(activityLoad({ durationSec: 3600, avgHr: 170 }, hr) > activityLoad({ durationSec: 3600, avgHr: 130 }, hr));
  // Intégration au bilan
  const plan = generatePlan(base, { today: TODAY });
  const { adjustment } = adaptPlan(plan, {}, '2026-12-02', null, null, { zone: 'high', ratio: 1.7 });
  assert.ok(adjustment.reasons.some((r) => r.includes('20 %')));
});

test('zone facile en bpm : Karvonen si FC de repos connue, sinon % FC max', async () => {
  const { easyHrCeiling } = await import('../app/js/engine/coach.js');
  // Réserve de FC : 60 + 0,78 × (190 − 60) = 161
  assert.equal(easyHrCeiling({ maxHr: 190, restHr: 60 }).bpm, 161);
  assert.equal(easyHrCeiling({ maxHr: 190, restHr: 60 }).mode, 'reserve');
  // Sans FC de repos : 0,84 × 190 = 160
  assert.equal(easyHrCeiling({ maxHr: 190 }).bpm, 160);
  assert.equal(easyHrCeiling({ maxHr: 190 }).mode, 'max');
  assert.equal(easyHrCeiling(null), null);
  assert.equal(easyHrCeiling({}), null);
});

test('courbe de forme : charge chronique dans le temps, seulement avec assez d\'historique', async () => {
  const { loadTrend } = await import('../app/js/engine/load.js');
  const t = '2026-12-20';
  const act = (date, load) => ({ date, trainingLoad: load, durationSec: 3600 });
  const acts = [];
  for (let d = 56; d >= 0; d -= 2) { const x = new Date(t); x.setUTCDate(x.getUTCDate() - d); acts.push(act(x.toISOString().slice(0, 10), 60)); }
  const trend = loadTrend(acts, t, null, { weeks: 8 });
  assert.ok(trend.length >= 3, 'plusieurs points de forme');
  assert.ok(trend.every((p) => p.fitness > 0 && p.date && p.zone), 'chaque point a une forme, une date et une fraîcheur');
  assert.equal(loadTrend([act('2026-12-19', 50)], t, null).length, 0, 'aucun point sans historique suffisant');
});

test('reporter un renforcement : déplacé sans échange (coexiste avec la course), sa date est exclue des options', async () => {
  const { moveStrength, strengthMoveOptions } = await import('../app/js/engine/reschedule.js');
  const plan = generatePlan(base, { today: TODAY });
  const renfo = plan.weeks.flatMap((w) => w.sessions).find((s) => s.type === 'strength');
  assert.ok(renfo, 'le plan contient du renforcement');
  const run = plan.weeks.flatMap((w) => w.sessions).find((s) => s.type === 'easy' && s.date !== renfo.date);
  // Reporter le renfo sur le jour d'une course : la course ne bouge pas (coexistence, pas d'échange)
  const moved = moveStrength(plan, renfo.id, run.date);
  const movedRenfo = moved.weeks.flatMap((w) => w.sessions).find((s) => s.id === renfo.id);
  const sameRun = moved.weeks.flatMap((w) => w.sessions).find((s) => s.id === run.id);
  assert.equal(movedRenfo.date, run.date, 'renfo déplacé au jour voulu');
  assert.equal(movedRenfo.movedFrom, renfo.date, 'origine mémorisée');
  assert.equal(sameRun.date, run.date, 'la course n\'a pas bougé');
  // Options : sa date actuelle est exclue, au moins un autre jour proposé
  const opts = strengthMoveOptions(plan, {}, renfo.id, renfo.date);
  assert.ok(!opts.includes(renfo.date), 'sa date actuelle est exclue');
  assert.ok(opts.length >= 1, 'au moins un jour proposé');
  assert.throws(() => moveStrength(plan, run.id, renfo.date), /renforcement introuvable/, 'refuse une séance non-renfo');
});

test('forme du jour : séance dure décalée si forme très basse', async () => {
  const { readinessAdvice, formClass } = await import('../app/js/engine/readiness.js');
  const hard = { type: 'threshold' }, easy = { type: 'easy' };
  assert.equal(readinessAdvice({ score: 18 }, hard).action, 'swap');
  assert.equal(readinessAdvice({ score: 40 }, hard).action, 'suggest');
  assert.equal(readinessAdvice({ score: 70, hrvStatus: 'LOW' }, hard).action, 'suggest');
  assert.equal(readinessAdvice({ score: 80 }, hard).action, 'none');
  assert.equal(readinessAdvice({ score: 15 }, easy).action, 'shorten');
  assert.equal(formClass({}), null);
});

test('rattrapage : séance clé manquée replacée sur un footing sûr, sinon abandonnée', async () => {
  const { missedKeySession, findSafeDay, makeUp } = await import('../app/js/engine/reschedule.js');
  const plan = generatePlan({ ...base, level: 'advanced', days: [0, 1, 3, 4, 6], longRunDay: 6 }, { today: TODAY });
  const w = plan.weeks.find((x) => x.phase === 'build' && !x.recovery);
  const hard = w.sessions.find((s) => ['threshold', 'intervals'].includes(s.type));
  const dayAfter = new Date(hard.date); dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  const today = dayAfter.toISOString().slice(0, 10);
  const missed = missedKeySession(plan, {}, today);
  assert.ok(missed);
  const target = findSafeDay(plan, {}, missed.id, today);
  if (target) {
    const { plan: next, dropped } = makeUp(plan, {}, missed.id, target.id);
    const ms = next.weeks.flatMap((x) => x.sessions).find((s) => s.id === missed.id);
    assert.equal(ms.date, target.date);
    assert.equal(dropped, target.id);
  }
  // Avec futsal la veille de chaque footing restant : aucun jour sûr
  const busy = structuredClone(plan);
  busy.profile.otherSports = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, kind: 'futsal' }));
  assert.equal(findSafeDay(busy, {}, missed.id, today), null);
});

test('récap : chiffres, prévu/réalisé, étapes et conclusion', async () => {
  const { buildRecap } = await import('../app/js/engine/recap.js');
  const { flattenSteps } = await import('../app/js/engine/analysis.js');
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, easyPaceSec: 510 }, { today: TODAY });
  const w = plan.weeks[1];
  const easy = w.sessions.find((s) => s.type === 'easy');
  const entry = { done: true, feel: 'ok', source: 'garmin', actualKm: easy.km, durationSec: easy.km * 530, paceSecPerKm: 530, avgHr: 150, maxHr: 165, calories: 380, elevationGainM: 12, cadence: 158, trainingEffect: 2.3, analysis: { verdict: 'success', details: [] } };
  const r = buildRecap(easy, entry, { paces: w.paces, hr: { maxHr: 190 }, next: { title: 'Sortie longue', dateLabel: 'dimanche 29 novembre' } });
  assert.ok(r.stats.some((s) => s.label === 'Calories' && s.value === '380 kcal'));
  assert.ok(r.compare.every((c) => c.ok));
  assert.ok(r.conclusion[0].startsWith('Footing réussi'));
  assert.ok(r.conclusion.some((c) => c.includes('150 bpm, dans ta zone facile (sous 160 bpm)')));
  assert.ok(r.conclusion.at(-1).includes('Prochaine séance : Sortie longue'));
  // Étapes : séance structurée lancée depuis la montre (un tour par étape)
  const hills = plan.weeks.flatMap((x) => x.sessions).find((s) => s.type === 'fartlek' || s.type === 'hills');
  const laps = flattenSteps(hills.steps).map((st) => ({ distanceM: st.dur.type === 'distance' ? st.dur.m : 200, durationSec: st.dur.type === 'time' ? st.dur.s : 600, avgHr: 150 }));
  const r2 = buildRecap(hills, { done: true, feel: 'ok', laps }, { paces: w.paces });
  assert.equal(r2.steps.length, laps.length);
  // Séance manuelle : pas de chiffres Garmin, mais une conclusion
  const r3 = buildRecap(easy, { done: true, feel: 'hard', actualKm: 2 }, { paces: w.paces });
  assert.ok(r3.conclusion.length >= 2);
});

test('import : une course antérieure au plan ne coche jamais une séance du plan', async () => {
  const { applyActivities } = await import('../app/js/engine/garminsync.js');
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, easyPaceSec: 510, days: [0, 3, 6], longRunDay: 6 }, { today: TODAY });
  const r = applyActivities(plan, {}, [{ id: 1, date: '2026-11-13', start: '2026-11-13 18:00', type: 'running', distanceKm: 4.5, durationSec: 2400 }], {});
  assert.equal(Object.keys(r.log).length, 0);
  assert.equal(r.freeRuns.length, 0);
  assert.equal(r.known[1], 'pre-plan');
});

test('pause : séances retirées, reprise allégée, fin de cycle repoussée', async () => {
  const { pausePlan, resumeFactors } = await import('../app/js/engine/pause.js');
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, easyPaceSec: 510, days: [0, 3, 6], longRunDay: 6 }, { today: TODAY });
  const from = '2026-12-02';
  const { plan: p2, pause } = pausePlan(plan, {}, from, 7, 'illness');
  const all = p2.weeks.flatMap((w) => w.sessions);
  assert.equal(pause.until, '2026-12-09');
  assert.ok(!all.some((s) => s.date >= from && s.date < '2026-12-09'), 'aucune séance pendant la pause');
  assert.ok(all.some((s) => s.date >= '2026-12-09'), 'le plan reprend');
  assert.equal(p2.profile.raceDate > plan.profile.raceDate, true, 'fin de cycle repoussée');
  const ids = all.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  const volBefore = plan.weeks.find((w) => w.start === '2026-11-30').volumeKm;
  const volAfter = p2.weeks.find((w) => w.start === '2026-12-14').volumeKm;
  assert.ok(volAfter <= volBefore * 1.1, 'reprise sans hausse brutale');
  assert.ok(resumeFactors(21).vdot < 0 && resumeFactors(3).vdot === 0);
  // Prépa course : la date de course ne bouge pas
  const race = generatePlan(base, { today: TODAY });
  const { plan: r2 } = pausePlan(race, {}, '2026-12-10', 10, 'holiday');
  assert.equal(r2.profile.raceDate, race.profile.raceDate);
  assert.equal(r2.weeks.at(-1).sessions.at(-1).type, 'race');
  // Juste avant la course : pas de recalcul, seulement les jours retirés
  const { plan: r3 } = pausePlan(race, {}, '2027-03-14', 3, 'illness');
  assert.ok(!r3.weeks.flatMap((w) => w.sessions).some((s) => s.date >= '2027-03-14' && s.date < '2027-03-17'));
});

test('douleur : forte → pause conseillée ; moyenne ou répétée → prudence ; avis médical mentionné', async () => {
  const { painAdvice } = await import('../app/js/engine/pain.js');
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, easyPaceSec: 510, days: [0, 3, 6], longRunDay: 6 }, { today: TODAY });
  const ss = plan.weeks.flatMap((w) => w.sessions).filter((s) => !s.optional);
  const today = ss[5].date;
  assert.equal(painAdvice(plan, {}, today), null);
  const strong = { [ss[4].id]: { done: true, pain: { level: 8, zone: 'knee' } } };
  const a = painAdvice(plan, strong, today);
  assert.equal(a.level, 'stop');
  assert.ok(a.actions.includes('pause') && a.text.includes('consulte'));
  const twice = { [ss[3].id]: { done: true, pain: { level: 2, zone: 'achilles' } }, [ss[4].id]: { done: true, pain: { level: 2, zone: 'achilles' } } };
  assert.equal(painAdvice(plan, twice, today).level, 'caution');
  // « C'est passé » efface les douleurs antérieures
  assert.equal(painAdvice(plan, strong, today, ss[4].date), null);
});

test('pause : une séance déjà faite le jour même est conservée', async () => {
  const { pausePlan } = await import('../app/js/engine/pause.js');
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, easyPaceSec: 510, days: [1, 3, 6], longRunDay: 6 }, { today: TODAY });
  const tue = plan.weeks[0].sessions.find((s) => s.date === '2026-11-17');
  const log = { [tue.id]: { done: true, feel: 'hard', pain: { level: 8, zone: 'knee' } } };
  const { plan: p2 } = pausePlan(plan, log, '2026-11-17', 3, 'injury');
  assert.ok(p2.weeks.flatMap((w) => w.sessions).some((s) => s.id === tue.id), 'historique conservé');
});

test('petite base (sortie max 3 km) : on part du niveau réel, progression douce', () => {
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3, easyPaceSec: 570 }, { today: TODAY });
  const runs = (w) => w.sessions.filter((s) => s.km);
  const w0 = runs(plan.weeks[0]);
  assert.ok(Math.max(...w0.map((s) => s.min)) <= 32, 'semaine 1 : aucune séance > 32 min');
  let prev = 0;
  for (const w of plan.weeks.slice(0, 7)) {
    const long = Math.max(...runs(w).map((s) => s.km));
    if (prev) assert.ok(long <= prev * 1.25 + 0.6, `sortie longue ${prev} → ${long}`);
    prev = Math.max(prev, long); // une semaine allégée ne remet pas la rampe à zéro
  }
});

test('séance avancée avant le début du plan : la course du jour est bien reconnue', () => {
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3 }, { today: TODAY });
  const first = plan.weeks[0].sessions.find((s) => s.km);
  const moved = moveSession(plan, first.id, TODAY, {}).plan;
  const act = { id: 'a1', date: TODAY, start: `${TODAY}T15:00:00`, type: 'running', distanceKm: 2.3, durationSec: 1300 };
  const r = applyActivities(moved, {}, [act], {});
  assert.notEqual(r.known.a1, 'pre-plan');
  assert.ok(r.log[first.id]?.done, 'séance cochée');
});

test('footing bonus : ajouté aujourd\'hui sans déplacer le plan, reconnu à l\'import', () => {
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3 }, { today: TODAY });
  assert.ok(canAddBonus(plan, {}, TODAY));
  const before = plan.weeks.flatMap((w) => w.sessions).map((s) => `${s.id}@${s.date}`);
  const { plan: p2, id } = addBonus(plan, TODAY);
  const after = p2.weeks.flatMap((w) => w.sessions);
  assert.deepEqual(after.filter((s) => s.id !== id).map((s) => `${s.id}@${s.date}`), before);
  const b = after.find((s) => s.id === id);
  assert.equal(b.date, TODAY); assert.ok(b.min <= 27, `bonus ${b.min} min`);
  assert.ok(!canAddBonus(p2, {}, TODAY), 'pas deux bonus le même jour');
  const r = applyActivities(p2, {}, [{ id: 'a1', date: TODAY, start: `${TODAY}T15:00:00`, type: 'running', distanceKm: 2.4, durationSec: 1320 }], {});
  assert.ok(r.log[id]?.done, 'bonus coché');
  const first = plan.weeks[0].sessions.find((s) => s.km);
  assert.ok(!r.log[first.id], 'la séance de lundi reste à faire');
});

test('footing bonus : distance et lignes droites choisies', () => {
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3 }, { today: TODAY });
  const b = addBonus(plan, TODAY, { km: 4, strides: true }).plan.weeks.flatMap((w) => w.sessions).find((s) => s.bonus);
  assert.ok(b.km >= 3.5 && b.km <= 5.5, `distance ~4 km respectée (${b.km})`);
  assert.match(b.title, /lignes droites/, 'option lignes droites prise en compte');
  const b2 = addBonus(plan, TODAY, {}).plan.weeks.flatMap((w) => w.sessions).find((s) => s.bonus);
  assert.equal(b2.title, 'Footing bonus', 'sans option : footing simple, distance auto');
});

test('footing dur ou cœur haut : le footing suivant (≤ 3 j) est allégé de 20 %, sinon rien', async () => {
  const { applyEasyFeedback } = await import('../app/js/engine/easyfeedback.js');
  const plan0 = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3 }, { today: TODAY });
  const { plan, id } = addBonus(plan0, TODAY);
  const hr = { maxHr: 190, restHr: 60 };
  const nextOf = (p) => p.weeks.flatMap((w) => w.sessions).find((s) => s.date > TODAY && ['easy', 'long'].includes(s.type));
  const before = nextOf(plan);
  // Correct + cœur dans la zone : inchangé
  let r = applyEasyFeedback(plan, { [id]: { done: true, feel: 'ok', avgHr: 140 } }, id, hr);
  assert.equal(r.note, null);
  // Cœur haut (160 bpm ≈ 77 %… non ; 165 ≈ 81 % de réserve) : allégé
  r = applyEasyFeedback(plan, { [id]: { done: true, feel: 'ok', avgHr: 165 } }, id, hr);
  assert.ok(r.note, 'note attendue');
  const after = nextOf(r.plan);
  assert.equal(after.id, before.id);
  assert.ok(after.min < before.min * 0.9, `${before.min} → ${after.min}`);
  assert.ok(after.eased);
  // Ressenti dur sans FC : allégé aussi ; pas deux fois
  const r2 = applyEasyFeedback(plan, { [id]: { done: true, feel: 'hard' } }, id, null);
  assert.ok(r2.note);
  assert.equal(applyEasyFeedback(r2.plan, { [id]: { done: true, feel: 'hard' } }, id, null).note, null);
});

test('futsal noté sans montre : la durée et le ressenti comptent dans la charge', async () => {
  const { manualActivities, activityLoad } = await import('../app/js/engine/load.js');
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3, otherSports: [{ day: 2, kind: 'futsal' }] }, { today: TODAY });
  const futsal = plan.weeks[0].sessions.find((s) => s.type === 'sport');
  const acts = manualActivities(plan, { [futsal.id]: { done: true, feel: 'hard', sportMin: 60 } });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].date, futsal.date);
  assert.equal(activityLoad(acts[0], null), Math.round(60 * 8 * 0.45));
  // Importé de Garmin : pas de double comptage
  assert.equal(manualActivities(plan, { [futsal.id]: { done: true, feel: 'hard', sportMin: 60, source: 'garmin' } }).length, 0);
});

test('renforcement : 2 séances/sem., après le 1er footing + un soir libre, jamais la veille d\'un sport', () => {
  const otherSports = [{ day: 2, kind: 'futsal' }, { day: 6, kind: 'futsal' }, { day: 5, kind: 'referee' }];
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3, days: [0, 2, 6], longRunDay: 6, otherSports }, { today: TODAY });
  const wd = (d) => (new Date(d).getUTCDay() + 6) % 7;
  for (const w of plan.weeks.slice(0, -1).filter((x) => !x.sessions.some((s) => s.type === 'test'))) {
    const st = w.sessions.filter((s) => s.type === 'strength');
    assert.equal(st.length, 2, `semaine ${w.index}`);
    assert.deepEqual(st.map((s) => wd(s.date)), [0, 3], 'lundi après le footing + jeudi');
    for (const s of st) { assert.ok(s.optional); assert.ok(s.min >= 12 && s.min <= 20, `${s.min} min`); }
  }
  assert.equal(plan.weeks[0].sessions.find((s) => s.type === 'strength').level, 0);
  assert.equal(plan.weeks[9].sessions.find((s) => s.type === 'strength').level, 2);
  // Désactivable
  const off = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, strength: false }, { today: TODAY });
  assert.ok(!off.weeks.some((w) => w.sessions.some((s) => s.type === 'strength')));
});

test('changer ses jours : passé et séances faites conservés, avenir recalculé, fin inchangée', async () => {
  const { replanDays } = await import('../app/js/engine/replan.js');
  const prof = { ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3, days: [0, 2, 6], longRunDay: 6,
    otherSports: [{ day: 2, kind: 'futsal' }, { day: 6, kind: 'futsal' }] };
  const plan = generatePlan(prof, { today: TODAY });
  const today = '2026-12-02'; // mercredi, semaine 3
  const log = {};
  for (const s of plan.weeks.flatMap((w) => w.sessions)) if (s.date < today && !s.optional) log[s.id] = { done: true, feel: 'ok' };
  const { plan: p2 } = replanDays(plan, log, today, { days: [1, 3, 5], longRunDay: 5, otherSports: [{ day: 2, kind: 'futsal' }] });
  const all1 = plan.weeks.flatMap((w) => w.sessions), all2 = p2.weeks.flatMap((w) => w.sessions);
  for (const s of all1.filter((x) => x.date < today)) assert.ok(all2.some((y) => y.id === s.id && y.date === s.date), `passé conservé ${s.id}`);
  const wd = (d) => (new Date(d).getUTCDay() + 6) % 7;
  for (const s of all2.filter((x) => x.date >= today && !x.optional && x.type !== 'strength')) assert.ok([1, 3, 5].includes(wd(s.date)), `${s.date} ${s.title}`);
  assert.equal(p2.weeks.length, plan.weeks.length);
  assert.equal(new Set(all2.map((s) => s.id)).size, all2.length, 'ids uniques');
  const lastRun = (p) => p.weeks.at(-1).sessions.filter((s) => !s.optional).at(-1);
  assert.equal(wd(lastRun(p2).date), 5, 'test final le nouveau jour de sortie longue');
  // Pas de recul brutal : volume de la semaine suivante proche de l'ancien
  const nextOld = plan.weeks.find((w) => w.start > today), nextNew = p2.weeks.find((w) => w.start > today);
  assert.ok(Math.abs(nextNew.volumeKm - nextOld.volumeKm) <= nextOld.volumeKm * 0.35, `${nextOld.volumeKm} → ${nextNew.volumeKm}`);
  // Renforcement : niveau qui suit l'avancement (pas de retour au niveau 1)
  const lateStr = p2.weeks[9].sessions.find((s) => s.type === 'strength');
  assert.equal(lateStr.level, 2);
});

test('mise à niveau du moteur : ancien plan enrichi (renfo), historique et bonus conservés, une seule fois', async () => {
  const { upgradePlan } = await import('../app/js/engine/upgrade.js');
  const { ENGINE_VERSION } = await import('../app/js/engine/plan.js');
  const prof = { ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3, days: [0, 2, 6], longRunDay: 6, strength: undefined };
  // Ancien plan (v1) : sans renfo ni champ engine
  const fresh = generatePlan(prof, { today: TODAY });
  const old = { ...fresh, engine: undefined, weeks: fresh.weeks.map((w) => ({ ...w, sessions: w.sessions.filter((s) => s.type !== 'strength') })) };
  const today = '2026-11-25';
  const log = {};
  for (const s of old.weeks.flatMap((w) => w.sessions)) if (s.date < today) log[s.id] = { done: true, feel: 'ok' };
  const withBonus = addBonus(old, today).plan;
  const r = upgradePlan(withBonus, log, today);
  assert.ok(r && r.notes.length);
  assert.equal(r.plan.engine, ENGINE_VERSION);
  const all = r.plan.weeks.flatMap((w) => w.sessions);
  for (const id of Object.keys(log)) assert.ok(all.some((s) => s.id === id), `historique ${id}`);
  assert.ok(all.some((s) => s.bonus && s.date === today), 'bonus conservé');
  assert.ok(all.some((s) => s.type === 'strength' && s.date > today), 'renfo ajouté pour la suite');
  assert.ok(!all.some((s) => s.type === 'strength' && s.date < today), 'passé inchangé');
  assert.equal(upgradePlan(r.plan, log, today), null, 'pas deux fois');
  assert.equal(upgradePlan(withBonus, log, today, { paused: true }), null, 'pas pendant une pause');
});

test('plan pas encore commencé : un bonus fait avant le début reste dans l\'historique après recalcul', async () => {
  const { upgradePlan } = await import('../app/js/engine/upgrade.js');
  const prof = { ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3, days: [0, 2, 6], longRunDay: 6 };
  const fresh = generatePlan(prof, { today: TODAY }); // samedi : plan démarre lundi
  const old = { ...fresh, engine: undefined, weeks: fresh.weeks.map((w) => ({ ...w, sessions: w.sessions.filter((s) => s.type !== 'strength') })) };
  const { plan, id } = addBonus(old, TODAY);
  const log = { [id]: { done: true, feel: 'ok', actualKm: 2.6 } };
  const r = upgradePlan(plan, log, TODAY);
  const all = r.plan.weeks.flatMap((w) => w.sessions);
  assert.ok(all.some((s) => s.id === id && s.date === TODAY), 'bonus du samedi conservé');
  assert.equal(new Set(all.map((s) => s.id)).size, all.length);
  assert.ok(all.some((s) => s.type === 'strength'));
});

test('test VMA : jamais le lendemain du futsal / de la sortie longue ; veille allégée, sans renfo', () => {
  const otherSports = [{ day: 2, kind: 'futsal' }, { day: 6, kind: 'futsal' }, { day: 5, kind: 'referee' }];
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3, days: [0, 2, 6], longRunDay: 6, otherSports }, { today: TODAY });
  const wd = (d) => (new Date(d).getUTCDay() + 6) % 7;
  const all = plan.weeks.flatMap((w) => w.sessions);
  const test = all.find((s) => s.type === 'test' && s.title.includes('6 min'));
  assert.ok(test, 'un test VMA dans le plan');
  const d = wd(test.date);
  assert.ok(![2, 6, 5].includes(d), `pas un jour de sport (${d})`);
  assert.ok(![3, 0, 6].includes(d), `pas le lendemain d'un sport ni de la sortie longue (${d})`);
  const veille = addDaysT(test.date, -1), lendemain = test.date;
  for (const s of all.filter((x) => x.date === veille || x.date === lendemain)) {
    assert.notEqual(s.type, 'strength', `pas de renfo ${s.date}`);
    assert.ok(!s.steps?.some((st) => st.kind === 'repeat') || s.type === 'test', `pas d'accélérations la veille ${s.title}`);
  }
  const w = plan.weeks.find((x) => x.sessions.includes(test));
  assert.equal(w.sessions.filter((s) => !s.optional).length, 3, 'toujours 3 séances cette semaine');
});
function addDaysT(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

test('pas dispo : jours de remplacement sûrs dans la semaine, jamais sur une autre course', async () => {
  const { unavailableOptions } = await import('../app/js/engine/reschedule.js');
  const otherSports = [{ day: 2, kind: 'futsal' }, { day: 6, kind: 'futsal' }, { day: 5, kind: 'referee' }];
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3, days: [0, 2, 6], longRunDay: 6, otherSports }, { today: TODAY });
  const w = plan.weeks[1];
  const runs = w.sessions.filter((s) => !s.optional && s.type !== 'strength');
  const runDates = new Set(runs.map((s) => s.date));
  const wd = (d) => (new Date(d).getUTCDay() + 6) % 7;
  for (const s of runs) {
    const opts = unavailableOptions(plan, {}, s.id, w.start);
    assert.ok(opts.length >= 1, `au moins une option pour ${s.title}`);
    for (const o of opts) {
      assert.ok(!runDates.has(o.date), 'pas sur une autre course');
      assert.ok(o.date >= w.start && o.date <= addDaysT(w.start, 6), 'même semaine');
      if (s.type === 'long') assert.ok(![2, 6, 5, 3, 0].includes(wd(o.date)), `sortie longue : ni sport ni lendemain (${o.label})`);
    }
  }
  // Rien avant aujourd'hui
  const mid = addDaysT(w.start, 3);
  for (const o of unavailableOptions(plan, {}, runs.at(-1).id, mid)) assert.ok(o.date >= mid);
});

test('bilan mensuel : course, futsal, arbitrage, renfo, calories, sans double comptage', async () => {
  const { monthlySummary, availableMonths, monthLabel } = await import('../app/js/engine/monthly.js');
  const otherSports = [{ day: 2, kind: 'futsal' }, { day: 5, kind: 'referee' }];
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3, days: [0, 3, 6], longRunDay: 6, otherSports }, { today: TODAY });
  const all = plan.weeks.flatMap((w) => w.sessions);
  const run = all.find((s) => s.type === 'easy' && s.date.startsWith('2026-11'));
  const ref = all.find((s) => s.sport === 'referee' && s.date.startsWith('2026-11'));
  const fut = all.find((s) => s.sport === 'futsal' && s.date.startsWith('2026-11'));
  const str = all.find((s) => s.type === 'strength' && s.date.startsWith('2026-11'));
  const acts = {
    1: { id: 1, date: run.date, type: 'running', distanceKm: 2.6, durationSec: 1320, avgHr: 150, paceSecPerKm: 508, calories: 250 },
    2: { id: 2, date: ref.date, type: 'running', distanceKm: 9, durationSec: 5400, calories: 700 },
    3: { id: 3, date: '2026-10-20', type: 'running', distanceKm: 2.5, durationSec: 1280, calories: 240 },
  };
  const known = { 1: run.id, 2: ref.id };
  const log = {
    [run.id]: { done: true, garminId: 1, source: 'garmin', actualKm: 2.6, calories: 250 },
    [ref.id]: { done: true, garminId: 2, source: 'garmin' },
    [fut.id]: { done: true, feel: 'hard', sportMin: 60 },
    [str.id]: { done: true, feel: 'ok' },
  };
  const { cur, prev, delta, lines } = monthlySummary({ plan, log, acts, known }, '2026-11', '2026-11-30');
  assert.equal(cur.run.n, 1); assert.equal(cur.run.km, 2.6); assert.equal(cur.run.kcal, 250);
  assert.equal(cur.referee.n, 1); assert.equal(cur.referee.kcal, 700);
  assert.equal(cur.futsal.n, 1); assert.equal(cur.futsal.min, 60); assert.ok(cur.futsal.kcalEstimated);
  assert.equal(cur.strength.n, 1);
  assert.equal(cur.total.sessions, 4);
  assert.equal(cur.total.kcal, 250 + 700 + 600 + Math.round(str.min * 5));
  assert.equal(prev.run.n, 1, 'octobre : la course pré-plan compte dans le bilan');
  assert.equal(delta.km, 4);
  assert.ok(lines.length >= 2);
  assert.deepEqual(availableMonths({ plan, acts }, '2026-12-05'), ['2026-10', '2026-11', '2026-12']);
  assert.equal(monthLabel('2026-11'), 'novembre 2026');
});

test('records, jalons, série : calcul et nouveautés à célébrer', async () => {
  const { computeRecords, newAchievements, streak } = await import('../app/js/engine/records.js');
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3, days: [0, 3, 6], longRunDay: 6 }, { today: TODAY });
  const acts = {
    1: { id: 1, date: '2026-11-14', type: 'running', distanceKm: 2.6, durationSec: 1290, paceSecPerKm: 496 },
    2: { id: 2, date: '2026-11-16', type: 'running', distanceKm: 2.3, durationSec: 1260 },
    3: { id: 3, date: '2026-11-22', type: 'running', distanceKm: 3.4, durationSec: 1830, paceSecPerKm: 538 },
    4: { id: 4, date: '2026-11-21', type: 'running', distanceKm: 9, durationSec: 5400 }, // arbitrage
    5: { id: 5, date: '2026-11-18', type: 'indoor_soccer', durationSec: 3600 },
  };
  const ref = plan.weeks[0].sessions.find((s) => s.sport === 'referee') ?? { id: 'x' };
  const st = { plan, log: {}, acts, known: { 4: ref.id } };
  if (ref.id === 'x') delete acts[4];
  const r = computeRecords(st, '2026-11-23');
  assert.equal(r.records.longestKm.value, 3.4);
  assert.equal(r.records.longestKm.prev, 2.6);
  assert.equal(r.records.bestPace.value, 496);
  assert.ok(!r.records.best5k, 'pas de 5 km estimé sans sortie de 5 km');
  assert.equal(r.milestones.find((m) => m.key === 'run20').date, '2026-11-14');
  assert.equal(r.milestones.find((m) => m.key === 'run30').date, '2026-11-22');
  const news = newAchievements(st, '2026-11-22', {}, '2026-11-23');
  assert.ok(news.some((n) => n.id === 'longestKm:2026-11-22'));
  assert.ok(news.some((n) => n.id === 'run30:2026-11-22'));
  assert.ok(!news.some((n) => n.key === 'bestPace'), 'pas de record d\'allure ce jour-là');
  assert.equal(newAchievements(st, '2026-11-22', Object.fromEntries(news.map((n) => [n.id, true])), '2026-11-23').length, 0, 'vu = plus annoncé');
  // Série : 2 semaines complètes puis une ratée
  const log = {};
  for (const w of plan.weeks.slice(0, 2)) for (const s of w.sessions) if (!s.optional && s.type !== 'strength') log[s.id] = { done: true };
  assert.deepEqual(streak({ plan, log }, addDaysT(plan.weeks[2].start, 2)), { current: 2, best: 2 });
  assert.deepEqual(streak({ plan, log }, addDaysT(plan.weeks[3].start, 2)), { current: 0, best: 2 });
});

test('avancer une séance : liste courses + renfo à venir, jamais faites ni jours de sport', async () => {
  const { movableToToday } = await import('../app/js/engine/reschedule.js');
  const otherSports = [{ day: 2, kind: 'futsal' }, { day: 5, kind: 'referee' }];
  const plan = generatePlan({ ...fit, fitnessGoal: 'regular', durationWeeks: 12, weeklyKm: 5, longestRunKm: 3, days: [0, 2, 6], longRunDay: 6, otherSports }, { today: TODAY });
  const t = '2026-11-15'; // dimanche de repos (avant le début lundi 16)
  const list = movableToToday(plan, {}, t);
  assert.ok(list.length >= 2, 'au moins course + renfo proposés');
  assert.ok(list.every((s) => s.date > t), 'rien avant aujourd\'hui');
  assert.ok(list.some((s) => s.type === 'strength'), 'le renfo est proposé');
  assert.ok(list.every((s) => s.type !== 'sport' && s.type !== 'race'), 'ni sport ni course objectif');
  // une séance faite n'est plus proposée
  const first = list[0];
  assert.ok(!movableToToday(plan, { [first.id]: { done: true } }, t).some((s) => s.id === first.id));
});
