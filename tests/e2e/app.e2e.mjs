// Tests de bout en bout : l'app tourne dans un iPhone simulé, avec un faux serveur Garmin.
// Lancement : npm run test:e2e   (nécessite Playwright + Chromium, et les dépendances Python du serveur)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, newPage, seed, stored, setActivities, garminCalls, failUploads, GARMIN_CFG, USER_PROFILE, APP } from './harness.mjs';

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
  await p.fill('#bonus-km', '4'); await p.check('#bonus-strides');
  await p.click('#bonus-go'); await p.waitForTimeout(400);
  const st = await stored(p);
  assert.equal(st.plan.weeks.flatMap((w) => w.sessions).length, before + 1);
  const bonus = st.plan.weeks.flatMap((w) => w.sessions).find((s) => s.id === 'bonus-2026-11-14');
  assert.ok(bonus.km >= 3.5 && bonus.km <= 5, `distance choisie respectée (${bonus.km} km)`);
  assert.match(bonus.title, /lignes droites/, 'option lignes droites prise en compte');
  await p.evaluate(() => { const k = 'run-coach:v1'; const s = JSON.parse(localStorage.getItem(k)); s.log['bonus-2026-11-14'] = { done: true, feel: 'ok', at: '2026-11-14', actualKm: 2.6, durationSec: 1290, avgHr: 152 }; localStorage.setItem(k, JSON.stringify(s)); });
  await p.reload(); await p.evaluate(() => { location.hash = '#/'; }); await p.waitForTimeout(600);
  assert.match(await p.evaluate(() => location.hash), /#\/recap\//, 'le récap s\'ouvre tout seul après la séance');
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForTimeout(400);
  assert.equal(await p.locator('#add-bonus, [data-move]').count(), 0, 'plus de 2e course proposée');
  assert.ok(await p.locator('text=Séance faite').count(), 'écran « Séance faite »');
  assert.ok(await p.locator('.coach-quote').count(), 'mot du coach visible');
  noErrors(p);
});

test('footing bonus : ré-ajout efface un ancien statut « sauté » et réapparaît sur Aujourd\'hui', async () => {
  const p = await newPage(env.browser);
  await seed(p, { mutate: `
    st.plan.weeks[0].sessions.push({ id: 'bonus-2026-11-14', date: '2026-11-14', type: 'easy', title: 'Footing bonus', bonus: true, steps: [], km: 2.5, min: 24 });
    st.log['bonus-2026-11-14'] = { skipped: true, at: '2026-11-14' };` });
  // Au départ, le bonus sauté n'apparaît pas comme séance du jour
  assert.ok(await p.locator('#add-bonus').count(), 'on peut quand même rajouter un bonus');
  await p.click('#add-bonus'); await p.waitForTimeout(300);
  await p.click('#bonus-go'); await p.waitForTimeout(400);
  const st = await stored(p);
  assert.ok(!st.log['bonus-2026-11-14']?.skipped, 'ancien statut « sauté » effacé');
  assert.equal(st.plan.weeks.flatMap((w) => w.sessions).filter((s) => s.id === 'bonus-2026-11-14').length, 1, 'pas de doublon');
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForTimeout(500);
  assert.match(await p.locator('#view').innerText(), /Footing bonus/, 'le bonus réapparaît sur Aujourd\'hui');
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
  // Sauvegarde de l'état de l'app sur le serveur (comme le fait l'app après chaque modification).
  const put = await fetch(`${GARMIN_CFG.url}/backup`, { method: 'PUT', headers: { 'X-Api-Key': GARMIN_CFG.key, 'content-type': 'application/json' }, body: JSON.stringify(await stored(p)) });
  assert.equal(put.status, 200);
  const call = async (method, params) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  assert.equal((await call('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'run-coach');
  const res = (await call('tools/call', { name: 'profil_et_plan', arguments: {} })).result;
  assert.equal(res.isError, false, JSON.stringify(res));
  assert.deepEqual(res.structuredContent.jours_course, ['lundi', 'mercredi', 'dimanche']);
  noErrors(p);
});

test('envoi refusé par le serveur (renfo) : pas de boucle de réaffichage, le défilement reste fluide', async () => {
  await failUploads('Renforcement');
  const p = await newPage(env.browser, '2026-11-15T10:00:00');
  await seed(p, { now: '2026-11-15T10:00:00', extra: { garmin: GARMIN_CFG } });
  await p.waitForTimeout(2500); // synchro + envoi (le renfo échoue)
  await p.evaluate(() => {
    window.__renders = 0;
    new MutationObserver(() => { window.__renders++; }).observe(document.getElementById('view'), { childList: true });
    window.scrollTo(0, 400);
  });
  await p.waitForTimeout(3000);
  const { renders, y } = await p.evaluate(() => ({ renders: window.__renders, y: window.scrollY }));
  assert.ok(renders <= 1, `écran réaffiché ${renders} fois en 3 s`);
  assert.ok(y > 100, `position de défilement conservée (${y})`);
  // Bouton « Envoyer » : retente, échoue, et redevient utilisable (jamais bloqué sur « Envoi en cours… »)
  await p.click('#push-week'); await p.waitForTimeout(1500);
  assert.equal((await p.locator('#push-week').innerText()).trim().toLowerCase(), 'envoyer sur ma montre');
  assert.ok(!(await p.locator('#push-week').isDisabled()));
  await failUploads(null);
  await p.click('#push-week'); await p.waitForTimeout(1500);
  assert.equal(await p.locator('#push-week').count(), 0, 'une fois le serveur à jour, tout part et le bouton disparaît');
  noErrors(p);
});

test('ChatGPT propose, l\'utilisateur applique ou refuse dans l\'app', async () => {
  const p = await newPage(env.browser, '2026-11-15T10:00:00');
  await seed(p, { now: '2026-11-15T10:00:00', extra: { garmin: GARMIN_CFG }, route: '#/profile' });
  await p.click('#gpt-url'); await p.waitForTimeout(400);
  const url = (await p.locator('.gpt-url code').innerText()).trim();
  const st0 = await stored(p);
  await fetch(`${GARMIN_CFG.url}/backup`, { method: 'PUT', headers: { 'X-Api-Key': GARMIN_CFG.key, 'content-type': 'application/json' }, body: JSON.stringify(st0) });
  const all = st0.plan.weeks.flatMap((w) => w.sessions);
  // Dates robustes à l'horloge réelle du serveur MCP : on vise des séances strictement à venir
  // (sinon le serveur refuse à juste titre une modification sur une date passée).
  const serverToday = new Date().toISOString().slice(0, 10);
  const future = all.filter((s) => s.date > serverToday);
  const easy = future.find((s) => s.type === 'easy');
  const long = future.find((s) => s.type === 'long');
  const call = async (args) => (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'proposer_modification', arguments: args } }) })).json()).result;
  const r1 = await call({ action: 'alleger', date: long.date, raison: 'Futsal la veille : on garde des jambes.' });
  assert.equal(r1.isError, false, JSON.stringify(r1));
  const r2 = await call({ action: 'sauter', date: easy.date, raison: 'Mauvaise nuit annoncée.' });
  assert.equal(r2.isError, false);
  await p.evaluate(() => { location.hash = '#/'; }); await p.reload(); await p.waitForTimeout(2500);
  assert.equal(await p.locator('.proposal').count(), 2, 'deux cartes « ChatGPT propose »');
  // Appliquer l'allègement de la sortie longue
  await p.locator('.proposal', { hasText: 'Alléger' }).locator('[data-apply]').click(); await p.waitForTimeout(600);
  await p.click('[data-close]');
  let st = await stored(p);
  const after = st.plan.weeks.flatMap((w) => w.sessions).find((s) => s.id === long.id);
  assert.ok(after.downgraded, 'sortie longue allégée');
  // Refuser le saut
  await p.locator('.proposal [data-refuse]').click(); await p.waitForTimeout(500);
  st = await stored(p);
  assert.ok(!st.log[easy.id]?.skipped, 'refusée : rien ne change');
  assert.equal(await p.locator('.proposal').count(), 0);
  const server = await (await fetch(`${GARMIN_CFG.url}/proposals`, { headers: { 'X-Api-Key': GARMIN_CFG.key } })).json();
  assert.deepEqual(server.proposals.map((x) => x.status).sort(), ['applied', 'refused']);
  noErrors(p);
});

test('rappels : la carte charge les réglages depuis le serveur (2 heures)', async () => {
  const p = await newPage(env.browser);
  await seed(p, { extra: { garmin: GARMIN_CFG }, route: '#/profile' });
  await p.waitForTimeout(400);
  assert.ok(await p.locator('#rem-card').count(), 'carte Rappels présente');
  await p.click('#rem-load'); await p.waitForTimeout(400);
  // Selon le support push du navigateur de test : soit le formulaire, soit le message « ouvre depuis l'icône ».
  if (await p.locator('#rem-form').count()) {
    assert.equal(await p.locator('#rem-form [name=eve-time]').inputValue(), '20:00');
    assert.equal(await p.locator('#rem-form [name=day-time]').inputValue(), '07:00');
  } else {
    assert.ok(await p.locator('#rem-body').innerText());
  }
  noErrors(p);
});

test('sommeil toujours affiché + avancer une autre séance (course / renfo) à aujourd\'hui', async () => {
  const p = await newPage(env.browser);
  await seed(p, { extra: { garmin: GARMIN_CFG } });
  await p.waitForTimeout(2500); // sync + readiness
  assert.ok(await p.locator('.sleep-card').count(), 'carte sommeil présente');
  assert.match(await p.locator('.sleep-card').innerText(), /[Ss]ommeil/);
  // Sélecteur « faire une autre séance aujourd'hui »
  await p.click('#advance'); await p.waitForTimeout(300);
  const opts = await p.locator('[data-adv]').count();
  assert.ok(opts >= 2, 'plusieurs séances proposées');
  const st0 = await stored(p);
  const renfo = st0.plan.weeks.flatMap((w) => w.sessions).find((x) => x.type === 'strength' && x.date > '2026-11-14');
  await p.locator(`[data-adv="${renfo.id}"]`).click(); await p.waitForTimeout(400);
  await p.click('[data-close]');
  const st = await stored(p);
  const moved = st.plan.weeks.flatMap((w) => w.sessions).find((x) => x.id === renfo.id);
  assert.equal(moved.date, '2026-11-14', 'renfo avancé à aujourd\'hui');
  assert.equal(moved.movedFrom, renfo.date);
  noErrors(p);
});

test('reporter un renforcement à un autre jour depuis sa page', async () => {
  const p = await newPage(env.browser);
  await seed(p);
  const st0 = await stored(p);
  const renfo = st0.plan.weeks.flatMap((w) => w.sessions).find((x) => x.type === 'strength' && x.date >= '2026-11-14');
  await p.evaluate((id) => { location.hash = `#/session/${id}`; }, renfo.id); await p.waitForTimeout(300);
  assert.ok(await p.locator('#postpone-strength').count(), 'bouton « Reporter » présent sur le renfo');
  await p.click('#postpone-strength'); await p.waitForTimeout(300);
  const target = await p.locator('.str-opt').first().getAttribute('data-date');
  await p.locator('.str-opt').first().click(); await p.waitForTimeout(400);
  const st = await stored(p);
  const moved = st.plan.weeks.flatMap((w) => w.sessions).find((x) => x.id === renfo.id);
  assert.equal(moved.date, target, 'renfo reporté au jour choisi');
  assert.equal(moved.movedFrom, renfo.date, 'origine mémorisée');
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
