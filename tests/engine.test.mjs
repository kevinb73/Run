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
