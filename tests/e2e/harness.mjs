// Outils des tests de bout en bout : serveur statique de l'app, faux serveur Garmin, iPhone simulé à date fixe.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

export const APP_PORT = 8090, GARMIN_PORT = 8091;
export const APP = `http://localhost:${APP_PORT}`, GARMIN = `http://localhost:${GARMIN_PORT}`;

export async function startServers() {
  const web = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, APP).pathname);
    if (path.endsWith('/')) path += 'index.html';
    try {
      const body = await readFile(join(ROOT, 'app', path));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  }).listen(APP_PORT);
  const py = spawn('python3', [join(ROOT, 'tests', 'e2e', 'fake_garmin.py'), String(GARMIN_PORT)], {
    env: { ...process.env, RUNCOACH_ORIGINS: APP }, stdio: ['ignore', 'inherit', 'inherit'],
  });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(`${GARMIN}/health`)).ok; } catch { /* démarrage */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('Le faux serveur Garmin n\'a pas démarré (dépendances : pip install -r server/requirements-test.txt).');
  const browser = await chromium.launch();
  return { browser, async stop() { await browser.close(); web.close(); py.kill(); } };
}

export const setActivities = (acts) => fetch(`${GARMIN}/__test/activities`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(acts) });
export const garminCalls = async () => (await fetch(`${GARMIN}/__test/calls`)).json();

/** Nouvelle page iPhone ; la date « maintenant » se règle avec setNow (stockée pour survivre aux rechargements). */
export async function newPage(browser, now = '2026-11-14T13:00:00') {
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro Max'], colorScheme: 'dark', serviceWorkers: 'block' });
  await ctx.addInitScript((def) => {
    const D = Date; const fixed = new D(localStorage.getItem('__now') || def).getTime();
    globalThis.Date = class extends D { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } };
  }, now);
  const page = await ctx.newPage();
  page.errors = [];
  page.requests = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  page.on('request', (r) => page.requests.push(`${r.method()} ${r.url()}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${APP}/`);
  return page;
}

/** Profil type de l'utilisateur (remise en forme, futsal mer/dim, arbitrage sam). */
export const USER_PROFILE = {
  mode: 'fitness', fitnessGoal: 'regular', durationWeeks: 12, level: 'intermediate', recent: null, easyPaceSec: 570,
  weeklyKm: 5, longestRunKm: 3, days: [0, 2, 6], longRunDay: 6,
  otherSports: [{ day: 2, kind: 'futsal' }, { day: 6, kind: 'futsal' }, { day: 5, kind: 'referee' }],
};

/** Injecte un état (plan généré par le vrai moteur + extras), règle la date, puis ouvre une route. */
export async function seed(page, { profile = USER_PROFILE, today = '2026-11-14', now, extra = {}, mutate = null, route = '#/' } = {}) {
  await page.evaluate(async ({ profile, today, extra, mutate, now }) => {
    const { generatePlan } = await import('/js/engine/plan.js');
    const plan = generatePlan(profile, { today });
    const st = { plan, log: {}, ...extra };
    if (mutate) new Function('st', mutate)(st);
    localStorage.setItem('run-coach:v1', JSON.stringify(st));
    localStorage.setItem('__now', now ?? `${today}T13:00:00`);
  }, { profile, today, extra, mutate, now });
  await page.reload();
  await page.evaluate((r) => { location.hash = r; }, route);
  await page.waitForTimeout(600);
}

export const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('run-coach:v1')));
export const GARMIN_CFG = { url: GARMIN, key: 'k', connected: true };
