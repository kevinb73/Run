// Tests de bout en bout : l'app tourne dans un iPhone simulé, avec un faux serveur Garmin.
// Lancement : npm run test:e2e   (nécessite Playwright + Chromium, et les dépendances Python du serveur)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, newPage, seed, stored, setActivities, garminCalls, GARMIN_CFG, USER_PROFILE, APP } from './harness.mjs';

let env;
before(async () => { env = await startServers(); });
after(async () => { await env?.stop(); });

const noErrors = (page) => assert.deepEqual(page.errors, [], 'aucune erreur dans la console');

test('questionnaire complet → plan créé, écran Aujourd\'hui', async () => {
  const p = await newPage(env.browser);
  const next = () => p.click('button[type=submit]');
  await p.click('text=Remise en forme'); await next();
  await p.click('text=Courir régulièrement'); await next();
  await p.click('text=12 semaines'); await next();
  await p.click('text=Intermédiaire'); await next();
  await p.click('[name=noref]'); await next();
  await p.fill('[name=ep-m]', '9'); await p.fill('[name=ep-s]', '30'); await next();
  for (let i = 0; i < 5; i++) await next();
  await p.waitForSelector('.cycle-strip');
  const st = await stored(p);
  assert.ok(st.plan.weeks.length === 12);
  assert.ok(st.plan.weeks[0].sessions.some((s) => s.type === 'strength'), 'renfo dans le plan');
  noErrors(p);
});

test('footing bonus : ajouté sans rien décaler, boutons masqués une fois couru', async () => {
  const p = await newPage(env.browser);
  await seed(p);
  const before = (await stored(p)).plan.weeks.flatMap((w) => w.sessions).length;
  await p.click('#add-bonus'); await p.waitForTimeout(300);
  await p.click('[data-close]');
  const st = await stored(p);
  assert.equal(st.plan.weeks.flatMap((w) => w.sessions).length, before + 1);
  await p.evaluate(() => { const k = 'run-coach:v1'; const s = JSON.parse(localStorage.getItem(k)); s.log['bonus-2026-11-14'] = { done: true, feel: 'ok', at: '2026-11-14', actualKm: 2.6, durationSec: 1290, avgHr: 152 }; localStorage.setItem(k, JSON.stringify(s)); });
  await p.reload(); await p.evaluate(() => { location.hash = '#/'; }); await p.waitForTimeout(600);
  assert.match(await p.evaluate(() => location.hash), /#\/recap\//, 'le récap s\'ouvre tout seul après la séance');
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForTimeout(400);
  assert.equal(await p.locator('#add-bonus, [data-move]').count(), 0, 'plus de 2e course proposée');
  assert.ok(await p.locator('text=Séance faite').count(), 'écran « Séance faite »');
  assert.ok(await p.locator('.coach-quote').count(), 'mot du coach visible');
  noErrors(p);
});

test('renfo : carte du jour, fiche avec exercices, « C\'est fait »', async () => {
  const p = await newPage(env.browser);
  await seed(p, { now: '2026-11-16T08:00:00' });
  await p.click('.strength-card a'); await p.waitForTimeout(300);
  assert.ok(await p.locator('text=Montées sur pointes').count());
  await p.click('#log-form label.choice:has-text("Correct")');
  await p.click('#log-form button[type=submit]'); await p.waitForTimeout(300);
  const st = await stored(p);
  const id = st.plan.weeks[0].sessions.find((s) => s.type === 'strength').id;
  assert.ok(st.log[id]?.done);
  noErrors(p);
});

test('sport sans montre : durée enregistrée (arbitrage, futsal à la place d\'une course)', async () => {
  const p = await newPage(env.browser);
  await seed(p, { now: '2026-11-21T20:00:00' });
  const st0 = await stored(p);
  const ref = st0.plan.weeks[0].sessions.find((s) => s.sport === 'referee').id;
  await p.evaluate((id) => { location.hash = `#/session/${id}`; }, ref); await p.waitForTimeout(300);
  await p.click('#log-form label.choice:has-text("Dur")'); await p.fill('[name=sportMin]', '90');
  await p.click('#log-form button[type=submit]'); await p.waitForTimeout(300);
  const alt = st0.plan.weeks[0].sessions.find((s) => s.alt).id;
  await p.evaluate((id) => { location.hash = `#/session/${id}`; }, alt); await p.waitForTimeout(300);
  await p.click('#log-form label.choice:has-text("Correct")'); await p.fill('[name=sportMin]', '60'); await p.click('#replaced'); await p.waitForTimeout(300);
  const st = await stored(p);
  assert.equal(st.log[ref].sportMin, 90);
  assert.equal(st.log[alt].sportMin, 60);
  assert.equal(st.log[alt].replacedBy, 'futsal');
  noErrors(p);
});

test('Mes jours : recalcul de la suite, résumé mis à jour', async () => {
  const p = await newPage(env.browser);
  await seed(p, { route: '#/profile' });
  await p.click('#days-btn'); await p.waitForTimeout(200);
  for (const d of [0, 2, 6]) await p.click(`#df [name=run][value="${d}"] + span`);
  for (const d of [1, 3, 5]) await p.click(`#df [name=run][value="${d}"] + span`);
  await p.selectOption('#df [name=long]', '5');
  await p.click('#df [name="sp-futsal"][value="6"] + span');
  await p.click('#df [name="sp-referee"][value="5"] + span');
  await p.click('#df button[type=submit]'); await p.waitForTimeout(500);
  await p.evaluate(() => { location.hash = '#/profile'; }); await p.waitForTimeout(300);
  const txt = await p.locator('#days-btn').locator('..').innerText();
  assert.match(txt, /mar, jeu, sam/);
  assert.match(txt, /sortie longue le samedi/);
  noErrors(p);
});

test('ancien plan : mis à niveau une seule fois, historique conservé', async () => {
  const p = await newPage(env.browser);
  await seed(p, {
    mutate: `delete st.plan.engine; for (const w of st.plan.weeks) w.sessions = w.sessions.filter((s) => s.type !== 'strength');
      st.plan.weeks[0].sessions.push({ id: 'bonus-2026-11-14', date: '2026-11-14', type: 'easy', title: 'Footing bonus', bonus: true, steps: [], km: 2.5, min: 24 });
      st.log['bonus-2026-11-14'] = { done: true, feel: 'ok', at: '2026-11-14' };`,
  });
  assert.ok(await p.locator('text=Plan mis à jour').count(), 'message de mise à jour');
  const st = await stored(p);
  const all = st.plan.weeks.flatMap((w) => w.sessions);
  assert.ok(st.plan.engine >= 3);
  assert.ok(all.some((s) => s.id === 'bonus-2026-11-14'), 'bonus conservé');
  assert.ok(all.some((s) => s.type === 'strength'), 'renfo ajouté');
  await p.reload(); await p.waitForTimeout(600);
  assert.equal(await p.locator('text=Plan mis à jour').count(), 0, 'pas deux fois');
  noErrors(p);
});

test('Garmin : course importée, séance avancée retirée de la montre à sa date d\'origine', async () => {
  await setActivities([{ activityId: 77, activityName: 'Course', startTimeLocal: '2026-11-14 15:00:00', distance: 2300, duration: 1300, movingDuration: 1290, averageHR: 150, activityType: { typeKey: 'running' } }]);
  const p = await newPage(env.browser, '2026-11-14T18:00:00');
  await seed(p, {
    now: '2026-11-14T18:00:00', extra: { garmin: GARMIN_CFG },
    mutate: `const s = st.plan.weeks[0].sessions.find((x) => x.type === 'easy'); st.pushed = { [s.id]: { date: s.date, workoutId: 1 } };
      s.movedFrom = s.date; s.date = '2026-11-14'; st.plan.weeks[0].sessions.sort((a, b) => a.date.localeCompare(b.date)); st.__id = s.id;`,
  });
  await p.waitForTimeout(2500);
  const st = await stored(p);
  assert.ok(st.log[st.__id]?.done, 'séance cochée par l\'import');
  assert.ok(p.requests.some((r) => r.startsWith('DELETE') && r.includes(`/workouts/${st.__id}`)), 'retirée de la montre');
  assert.ok((await garminCalls()).uploaded.length > 0, 'séances à venir envoyées');
  await setActivities([]);
  noErrors(p);
});

test('pas dispo : la séance passe au jour proposé (sans toucher aux autres), ou est sautée', async () => {
  const p = await newPage(env.browser);
  await seed(p);
  const st0 = await stored(p);
  const s = st0.plan.weeks[0].sessions.find((x) => x.type === 'easy');
  await p.evaluate((id) => { location.hash = `#/session/${id}`; }, s.id); await p.waitForTimeout(300);
  await p.click('#unavail'); await p.waitForTimeout(200);
  const date = await p.locator('.unav-opt').first().getAttribute('data-date');
  await p.locator('.unav-opt').first().click(); await p.waitForTimeout(300);
  const st = await stored(p);
  const moved = st.plan.weeks.flatMap((w) => w.sessions).find((x) => x.id === s.id);
  assert.equal(moved.date, date);
  assert.equal(moved.movedFrom, s.date);
  assert.equal(st.plan.weeks.flatMap((w) => w.sessions).filter((x) => x.date === date && !x.optional && x.type !== 'strength').length, 1, 'une seule course ce jour-là');
  // Sauter
  await p.evaluate((id) => { location.hash = `#/session/${id}`; }, s.id); await p.waitForTimeout(300);
  await p.click('#unavail'); await p.waitForTimeout(200); await p.click('#unav-skip'); await p.waitForTimeout(300);
  assert.ok((await stored(p)).log[s.id]?.skipped);
  noErrors(p);
});

test('bilan mensuel : carte dans Progrès, fenêtre le 1er du mois suivant (une seule fois)', async () => {
  const p = await newPage(env.browser);
  await seed(p, {
    now: '2026-12-02T09:00:00',
    mutate: `const all = st.plan.weeks.flatMap((w) => w.sessions);
      const run = all.find((s) => s.type === 'easy' && s.date < '2026-12-01');
      const fut = all.find((s) => s.alt === 'futsal' && s.date < '2026-12-01' && s.id !== run.id);
      st.acts = { 9: { id: 9, date: run.date, type: 'running', distanceKm: 2.6, durationSec: 1320, avgHr: 150, paceSecPerKm: 508, calories: 250 } };
      st.known = { 9: run.id };
      st.log[run.id] = { done: true, garminId: 9, source: 'garmin', actualKm: 2.6, feel: 'ok', at: run.date };
      st.log[fut.id] = { done: true, feel: 'hard', sportMin: 60, replacedBy: 'futsal', actualKm: 0, at: fut.date };
      st.monthlyShown = '2026-10';`,
  });
  await p.waitForTimeout(600);
  assert.ok(await p.locator('text=Ton bilan de novembre 2026').count(), 'fenêtre de bilan');
  await p.click('#see-month'); await p.waitForTimeout(400);
  assert.ok(await p.locator('text=Bilan de novembre 2026').count());
  const txt = await p.locator('#monthly').innerText();
  assert.match(txt, /2,6/); assert.match(txt, /Futsal/);
  await p.click('#monthly [aria-label="Mois suivant"]'); await p.waitForTimeout(200);
  assert.ok(await p.locator('text=Bilan de décembre 2026').count(), 'navigation');
  await p.evaluate(() => { location.hash = '#/'; }); await p.reload(); await p.waitForTimeout(800);
  assert.equal(await p.locator('text=Ton bilan de novembre 2026').count(), 0, 'pas deux fois');
  noErrors(p);
});

test('records : célébration sur Aujourd\'hui (une fois), carte dans Progrès', async () => {
  const p = await newPage(env.browser);
  await seed(p, {
    now: '2026-11-22T20:00:00',
    mutate: `st.acts = { 1: { id: 1, date: '2026-11-14', type: 'running', distanceKm: 2.6, durationSec: 1290, paceSecPerKm: 496 },
      3: { id: 3, date: '2026-11-22', type: 'running', distanceKm: 3.4, durationSec: 1830, paceSecPerKm: 538 } };`,
  });
  assert.ok(await p.locator('#celebrate').count(), 'carte de célébration');
  const txt = await p.locator('#celebrate').innerText();
  assert.match(txt, /Plus longue sortie/); assert.match(txt, /30 min de course/);
  await p.click('#celebrate-ok'); await p.waitForTimeout(300);
  assert.equal(await p.locator('#celebrate').count(), 0, 'disparaît une fois vue');
  await p.evaluate(() => { location.hash = '#/progress'; }); await p.waitForTimeout(400);
  const rec = await p.locator('.records').innerText();
  assert.match(rec, /3,4 km/); assert.match(rec, /Prochain cap/);
  noErrors(p);
});

test('coach ChatGPT : adresse secrète affichée, le connecteur répond (protocole MCP)', async () => {
  const p = await newPage(env.browser);
  await seed(p, { extra: { garmin: GARMIN_CFG }, route: '#/profile' });
  await p.waitForTimeout(800);
  await p.click('#gpt-url'); await p.waitForTimeout(500);
  const url = (await p.locator('.gpt-url code').innerText()).trim();
  assert.match(url, /\/mcp\/[0-9a-f]{32}$/);
  // L'app a sauvegardé son état sur le serveur : le connecteur doit pouvoir le lire.
  await p.waitForTimeout(4500);
  const call = async (method, params) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  assert.equal((await call('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'run-coach');
  const res = (await call('tools/call', { name: 'profil_et_plan', arguments: {} })).result;
  assert.equal(res.isError, false, JSON.stringify(res));
  assert.deepEqual(res.structuredContent.jours_course, [0, 2, 6]);
  noErrors(p);
});

test('toutes les pages s\'ouvrent sans erreur', async () => {
  const p = await newPage(env.browser);
  await seed(p);
  for (const r of ['#/', '#/plan', '#/progress', '#/profile']) {
    await p.evaluate((h) => { location.hash = h; }, r); await p.waitForTimeout(300);
  }
  const st = await stored(p);
  for (const s of st.plan.weeks[0].sessions) { await p.evaluate((id) => { location.hash = `#/session/${id}`; }, s.id); await p.waitForTimeout(150); }
  assert.ok(APP);
  noErrors(p);
});
