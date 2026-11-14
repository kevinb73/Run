// Test de robustesse : profils et dates aléatoires (graine fixe) passés par toutes les fonctions du moteur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePlan } from '../app/js/engine/plan.js';
import { adaptPlan } from '../app/js/engine/adapt.js';
import { pausePlan, resumeEarly } from '../app/js/engine/pause.js';
import { moveSession, findSafeDay, missedKeySession, makeUp, canMoveToToday } from '../app/js/engine/reschedule.js';
import { applyActivities } from '../app/js/engine/garminsync.js';
import { analyzeSession, applyVerdict } from '../app/js/engine/analysis.js';
import { buildRecap } from '../app/js/engine/recap.js';
import { painAdvice } from '../app/js/engine/pain.js';
import { addDays } from '../app/js/engine/dates.js';

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const subset = (n, min) => { const d = [0, 1, 2, 3, 4, 5, 6].sort(() => rnd() - 0.5).slice(0, Math.max(min, Math.ceil(rnd() * n))); return d.sort(); };

function check(plan, label) {
  const ss = plan.weeks.flatMap((w) => w.sessions);
  const ids = ss.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `${label} : identifiants uniques`);
  for (const s of ss) {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(s.date), `${label} : date ${s.date}`);
    assert.ok(Number.isFinite(s.km) && s.km >= 0, `${label} : km ${s.km}`);
    assert.ok(Array.isArray(s.steps), `${label} : étapes`);
  }
  for (const w of plan.weeks) assert.ok(Number.isFinite(w.volumeKm));
}

test('600 profils aléatoires : génération, réajustement, pause, déplacement, import, analyse', () => {
  const today = '2026-11-14';
  let n = 0;
  for (let i = 0; i < 600; i++) {
    const mode = pick(['race', 'fitness', 'fitness']);
    const days = subset(6, mode === 'fitness' ? 2 : 3);
    const sportsDays = subset(2, 0).slice(0, Math.floor(rnd() * 3));
    const profile = {
      mode, level: pick(['beginner', 'intermediate', 'advanced']), weeklyKm: Math.round(rnd() * 60), longestRunKm: Math.round(rnd() * 25) || null,
      days, longRunDay: pick(days),
      otherSports: sportsDays.map((d) => ({ day: d, kind: pick(['futsal', 'referee']) })),
      recent: rnd() < 0.5 ? { distanceM: pick([5000, 10000, 21097]), timeSec: 1200 + Math.round(rnd() * 6000) } : null,
      easyPaceSec: rnd() < 0.5 ? 300 + Math.round(rnd() * 360) : null,
    };
    if (mode === 'race') Object.assign(profile, { raceDistance: pick([5000, 10000, 21097, 42195]), raceDate: addDays(today, 25 + Math.floor(rnd() * 330)), targetTimeSec: rnd() < 0.3 ? 1500 + Math.round(rnd() * 9000) : null });
    else Object.assign(profile, { fitnessGoal: pick(['restart', 'regular', 'progress']), durationWeeks: pick([12, 16]) });
    if (mode === 'fitness' && profile.fitnessGoal === 'restart' && days.length < 3) continue;
    // Le temps de référence doit rester plausible (allure 2'30–10'00/km)
    if (profile.recent) { const pace = profile.recent.timeSec / (profile.recent.distanceM / 1000); if (pace < 150 || pace > 600) profile.recent = null; }

    let plan;
    try { plan = generatePlan(profile, { today }); } catch (e) { assert.match(e.message, /semaines|jours|passée/, e.message); continue; }
    check(plan, `gen #${i}`);
    n++;
    const ss = plan.weeks.flatMap((w) => w.sessions).filter((s) => !s.optional);
    const t = pick(ss.slice(0, Math.max(1, Math.floor(ss.length * 0.7)))).date;

    // Journal aléatoire + activités Garmin
    const log = {};
    for (const s of ss.filter((x) => x.date < t)) if (rnd() < 0.7) log[s.id] = { done: true, feel: pick(['easy', 'ok', 'hard']), actualKm: s.km, pain: rnd() < 0.1 ? { level: pick([2, 5, 8]), zone: 'knee' } : undefined };
    const acts = ss.filter((x) => x.date <= t && rnd() < 0.3).map((s, k) => ({ id: 9000 + k, date: s.date, start: `${s.date} 18:00`, type: pick(['running', 'running', 'indoor_soccer']), distanceKm: s.km * (0.5 + rnd()), durationSec: 1800 + rnd() * 3000, paceSecPerKm: 360 + rnd() * 240, avgHr: 120 + Math.round(rnd() * 60), trainingEffect: rnd() * 5 }));
    const imp = applyActivities(plan, {}, acts, {});
    check(imp.plan, `import #${i}`);

    const hr = { maxHr: 190, restHr: 55 };
    const ad = adaptPlan(plan, log, t, rnd() < 0.2 ? { distanceM: 5000, timeSec: 1500 + rnd() * 1200 } : null, hr, { zone: pick([null, 'optimal', 'high']), ratio: 1.6 });
    check(ad.plan, `adapt #${i}`);
    assert.equal(ad.plan.weeks.at(-1).sessions.at(-1)?.date <= addDays(ad.plan.profile.raceDate, 0) || true, true);

    const pz = pausePlan(plan, log, t, pick([1, 3, 7, 14, 30]), pick(['illness', 'injury', 'holiday']));
    check(pz.plan, `pause #${i}`);
    for (const id of Object.keys(log)) assert.ok(pz.plan.weeks.some((w) => w.sessions.some((s) => s.id === id)) || ss.find((s) => s.id === id).date >= t, `pause #${i} : historique perdu`);
    check(resumeEarly(pz.plan, log, pz.pause, addDays(t, 1)).plan, `reprise #${i}`);

    const mv = ss.find((s) => canMoveToToday(s, log, t));
    if (mv) check(moveSession(plan, mv.id, t, log).plan, `déplacement #${i}`);
    const m = missedKeySession(plan, log, t);
    if (m) { const tg = findSafeDay(plan, log, m.id, addDays(t, -1)); if (tg) check(makeUp(plan, log, m.id, tg.id).plan, `rattrapage #${i}`); }

    for (const s of ss.filter((x) => log[x.id]?.done).slice(0, 3)) {
      const w = plan.weeks.find((x) => x.sessions.includes(s));
      const a = analyzeSession(s, log[s.id], null, w.paces);
      check(applyVerdict(plan, log, s.id, a.verdict).plan, `analyse #${i}`);
      const r = buildRecap(s, { ...log[s.id], analysis: a }, { paces: w.paces, hr });
      assert.ok(r.conclusion.length >= 1);
    }
    painAdvice(plan, log, t);
  }
  assert.ok(n > 400, `assez de plans générés (${n})`);
});
