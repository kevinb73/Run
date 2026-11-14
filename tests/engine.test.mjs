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
  assert.ok(r.conclusion.some((c) => c.includes('79 % de ta FC max')));
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
