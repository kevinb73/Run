import * as store from './store.js';
import { generatePlan, PHASES, FITNESS_GOALS, SPORTS } from './engine/plan.js';
import { adaptPlan, recentStats, currentWeek } from './engine/adapt.js';
import { canMoveToToday, moveSession, downgradeToEasy, findSafeDay, missedKeySession, makeUp, shortenEasy, HARD_TYPES } from './engine/reschedule.js';
import { applyActivities } from './engine/garminsync.js';
import { analyzeSession, applyVerdict, QUALITY_TYPES } from './engine/analysis.js';
import { loadStatus, activityLoad, LOAD_LABELS } from './engine/load.js';
import { readinessAdvice, formClass, LEVEL_FR, HRV_FR } from './engine/readiness.js';
import { api, sessionPayload } from './garmin.js';
import { lineChart, volumeChart as weeklyVolumeChart, progressData } from './progress.js';
import { buildRecap } from './engine/recap.js';
import { ICONS } from './icons.js';
import { pausePlan, resumeEarly, PAUSE_REASONS } from './engine/pause.js';
import { painAdvice, PAIN_ZONES, PAIN_LEVELS } from './engine/pain.js';
import { vdotFromPerformance, predictTime } from './engine/vdot.js';
import { todayISO, daysBetween, addDays, mondayOf } from './engine/dates.js';
import { visibleSteps, defaultDraft } from './onboarding.js';
import { esc, pace, paceRange, duration, dateLong, dateShort, dateFull, ZONES, TYPE_ICON, stepDuration, KIND_LABEL, hm } from './format.js';

let state = normalize(store.load());

/** Champs ajoutés au fil des versions (Garmin) : valeurs par défaut. */
function normalize(st) {
  return { garmin: null, pushed: {}, known: {}, freeRuns: [], acts: {}, coachNotes: [], lastSync: 0, ...st };
}

/** Nouveau plan : on garde la connexion Garmin, on retire de la montre les séances de l'ancien plan. */
function resetPlan(plan) {
  const old = state;
  // On garde ce qui ne dépend pas du plan : profil cardiaque, activités (charge), dernière synchro des activités connues.
  state = normalize({ garmin: old.garmin, plan, log: {}, hr: old.hr, acts: old.acts, known: old.known });
  if (old.garmin?.connected) {
    const ids = Object.entries(old.pushed ?? {}).filter(([, info]) => info.date >= today()).map(([id]) => id);
    // Les nouvelles séances portent souvent les mêmes identifiants : on attend la fin du nettoyage
    // avant tout nouvel envoi, sinon une suppression tardive effacerait la séance tout juste envoyée.
    cleanup = (async () => {
      for (const id of ids) await api(old.garmin, 'DELETE', `/workouts/${encodeURIComponent(id)}`).catch(() => {});
    })();
  }
}
let cleanup = Promise.resolve();
let draft = state.plan ? { ...defaultDraft(), ...state.plan.profile } : defaultDraft();
let stepIdx = 0;

const view = document.getElementById('view');
const tabbar = document.getElementById('tabbar');
tabbar.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = ICONS[el.dataset.icon]; });
const today = () => todayISO();

function persist() {
  if (!store.save(state)) toast('Impossible d\'enregistrer (stockage plein ou mode privé).');
  scheduleBackup();
}

// ---------------- Sauvegarde sur le serveur ----------------

let backupTimer = null;
/** Sauvegarde automatique (quelques secondes après la dernière modification) si un serveur est configuré. */
function scheduleBackup() {
  if (!state.garmin?.url || !state.plan) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    const { garmin, ...rest } = state; // la clé du serveur ne part jamais dans la sauvegarde
    try {
      await api(state.garmin, 'PUT', '/backup', { app: 'run-coach', savedAt: new Date().toISOString(), ...rest, garminUrl: garmin?.url });
      state.lastBackup = Date.now();
      store.save(state);
    } catch { /* hors ligne : on réessaiera à la prochaine modification */ }
  }, 4000);
}

async function restoreFromServer(cfg) {
  const { data } = await api(cfg, 'GET', '/backup');
  if (!data?.plan) throw new Error('Sauvegarde vide.');
  const { app: _app, savedAt: _s, garminUrl: _u, ...rest } = data;
  let connected = false, name;
  try { ({ connected, name } = await api(cfg, 'GET', '/garmin/status')); } catch { /* serveur OK mais statut indisponible */ }
  state = normalize({ ...rest, garmin: { ...cfg, connected, name }, lastBackup: Date.parse(data.savedAt) || Date.now() });
  store.save(state);
  return data.savedAt;
}

function restoreSheet() {
  showSheet(`<h2>Restaurer depuis mon serveur</h2>
    <p class="muted">Récupère ton plan et ton historique sauvegardés automatiquement.</p>
    <form id="rs"><label class="field">Adresse du serveur<input type="url" name="url" value="${esc(state.garmin?.url ?? '')}" placeholder="https://…" required></label>
    <label class="field">Clé d'accès<input type="password" name="key" value="${esc(state.garmin?.key ?? '')}" required autocomplete="off"></label>
    <p class="error"></p><button class="btn primary" type="submit">Restaurer</button></form>`, (sheet) => {
    sheet.querySelector('#rs').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.currentTarget;
      try {
        const when = await restoreFromServer({ url: f.url.value.trim().replace(/\/$/, ''), key: f.key.value.trim() });
        closeSheet();
        toast(`Plan restauré (sauvegarde du ${new Date(when).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}).`);
        location.hash = '#/';
        route();
      } catch (ex) { f.querySelector('.error').textContent = ex.message; }
    });
  });
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

const allSessions = () => state.plan.weeks.flatMap((w) => w.sessions);
const findSession = (id) => allSessions().find((s) => s.id === id);

// ---------------- Routeur ----------------

function route() {
  const hash = location.hash.slice(1) || '/';
  const [, page, arg] = hash.split('/');
  if (!state.plan && page !== 'onboarding') { location.replace('#/onboarding'); return; }
  tabbar.hidden = page === 'onboarding';
  for (const a of tabbar.querySelectorAll('a')) a.classList.toggle('active', a.dataset.page === (page || 'today'));
  window.scrollTo(0, 0);
  switch (page) {
    case 'onboarding': return renderOnboarding();
    case 'plan': return renderPlan(arg);
    case 'session': return renderSession(arg);
    case 'profile': return renderProfile();
    case 'progress': return renderProgress();
    case 'recap': return renderRecap(arg);
    default: return renderToday();
  }
}

// ---------------- Questionnaire ----------------

function renderOnboarding() {
  const steps = visibleSteps(draft);
  stepIdx = Math.min(stepIdx, steps.length - 1);
  const step = steps[stepIdx];
  const last = stepIdx === steps.length - 1;
  view.innerHTML = `
    <section class="onboarding">
      <div class="progress"><div style="width:${((stepIdx + 1) / steps.length) * 100}%"></div></div>
      <p class="step-count">Question ${stepIdx + 1} / ${steps.length}</p>
      <h1>${esc(step.title)}</h1>
      <form id="step-form" novalidate>${step.render(draft)}
        <p class="error" role="alert"></p>
        <div class="actions">
          ${stepIdx > 0 ? '<button type="button" class="btn ghost" id="back">Retour</button>' : state.plan ? '<a class="btn ghost" href="#/">Annuler</a>' : '<span></span>'}
          <button type="submit" class="btn primary">${last ? 'Générer mon plan' : 'Continuer'}</button>
        </div>
      </form>
      ${stepIdx === 0 && !state.plan ? '<button class="btn ghost restore-link" id="restore">J\'ai déjà un plan : restaurer depuis mon serveur</button>' : ''}
    </section>`;
  view.querySelector('#restore')?.addEventListener('click', restoreSheet);
  const form = view.querySelector('#step-form');
  form.querySelectorAll('input[type=range]').forEach((r) => r.addEventListener('input', () => { r.nextElementSibling.textContent = `${r.value} km`; }));
  const noref = form.querySelector('[name=noref]');
  if (noref) form.addEventListener('input', (e) => { if (e.target !== noref && e.target.name !== 'noref') noref.checked = false; });
  view.querySelector('#back')?.addEventListener('click', () => { stepIdx--; renderOnboarding(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = step.read(form, draft);
    if (err) { form.querySelector('.error').textContent = err; return; }
    if (!last) { stepIdx++; renderOnboarding(); return; }
    try {
      const profile = cleanProfile(draft);
      resetPlan(generatePlan(profile, { today: today() }));
      persist();
      stepIdx = 0;
      location.hash = '#/';
    } catch (ex) {
      form.querySelector('.error').textContent = ex.message;
    }
  });
}

/** Ne garde que les réponses pertinentes pour le mode choisi. */
function cleanProfile(d) {
  const p = { ...d };
  if (p.recent) delete p.easyPaceSec;
  delete p.hasRecent;
  if (p.mode === 'fitness') {
    delete p.raceDate; delete p.raceDistance; delete p.targetTimeSec;
    if (p.fitnessGoal === 'restart') { p.level = 'beginner'; p.recent = null; }
  } else {
    p.mode = 'race';
    delete p.fitnessGoal; delete p.durationWeeks;
  }
  return p;
}

/** Nouveau cycle de remise en forme, à partir du niveau atteint. */
function newCycle() {
  const old = state.plan;
  const prof = { ...old.profile };
  delete prof.raceDate;
  const test = allSessions().find((s) => s.type === 'race' && state.log[s.id]?.timeSec);
  if (test) prof.recent = { distanceM: 5000, timeSec: state.log[test.id].timeSec };
  if (prof.fitnessGoal === 'restart') {
    Object.assign(prof, { fitnessGoal: 'regular', level: 'beginner', weeklyKm: 12, longestRunKm: 5, durationWeeks: 12 });
  } else {
    const last = old.weeks.slice(-4, -1);
    const done = last.flatMap((w) => w.sessions).filter((s) => state.log[s.id]?.done);
    prof.weeklyKm = Math.round(done.reduce((a, s) => a + (state.log[s.id].actualKm ?? s.km), 0) / Math.max(1, last.length)) || prof.weeklyKm;
    if (prof.fitnessGoal === 'regular' && done.length >= last.flatMap((w) => w.sessions).length * 0.8) prof.fitnessGoal = 'progress';
  }
  resetPlan(generatePlan(prof, { today: today() }));
  persist();
  showSheet(`<h2>Nouveau cycle prêt</h2><p>${esc(FITNESS_GOALS[prof.fitnessGoal].label)} · ${prof.durationWeeks} semaines${test ? ', allures recalibrées avec ton test 5 km' : ''}.</p><button class="btn primary" data-close>C'est parti</button>`);
  route();
}

/** Remplace les dates ISO d'un texte par « sam. 31 oct. ». */
const frDates = (txt) => String(txt).replace(/\d{4}-\d{2}-\d{2}/g, (d) => dateShort(d));

const sportIcon = (k) => ICONS[k === 'referee' ? 'referee' : 'futsal'];
const iconOf = (s) => (s.type === 'sport' ? sportIcon(s.sport) : ICONS[s.type]) ?? '•';

// ---------------- Aujourd'hui ----------------

function sessionCard(s, { big = false } = {}) {
  const entry = state.log[s.id];
  const status = entry?.replacedBy ? `<span class="badge done">${sportIcon(entry.replacedBy)}</span>` : entry?.done ? '<span class="badge done">Fait</span>' : entry?.skipped ? `<span class="badge skip">${s.optional ? 'Pas fait' : 'Sautée'}</span>` : '';
  return `<a class="card session-card type-${s.type} ${big ? 'big' : ''}" href="#/session/${s.id}">
    <span class="icon" aria-hidden="true">${iconOf(s)}</span>
    <span class="body">
      <span class="date">${esc(big ? dateLong(s.date) : dateShort(s.date))}</span>
      <span class="title">${esc(s.title)}</span>
      <span class="meta">${s.optional ? 'Facultatif' : `${s.km} km · ~${hm(s.min)}`}${s.alt ? ` · ou ${sportIcon(s.alt)} ${SPORTS[s.alt].label.toLowerCase()}` : ''}</span>
    </span>${status}</a>`;
}

/** Grand bloc « séance du jour » : ce qu'on doit voir en premier en ouvrant l'app. */
function todayHero(s, t, canMove) {
  const [main, ...rest] = s.title.split(' — ');
  const detail = rest.join(' — ');
  const w = weekOf(s.date);
  const E = w?.paces?.E;
  const fr = (n) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  const paceStat = ['easy', 'long'].includes(s.type) && E ? `<div><b class="range">${pace(E[0])}–${pace(E[1])}</b><span>allure /km</span></div>` : '';
  return `<section class="today">
    <p class="eyebrow">${s.date === t ? 'Aujourd\'hui' : 'Prochaine séance'} · ${esc(dateShort(s.date))}</p>
    <a class="today-link" href="#/session/${s.id}">
      <h1 class="mega">${esc(main)}</h1>
      ${detail ? `<p class="today-detail">${esc(detail)}</p>` : ''}
      <div class="today-stats"><div><b>${fr(s.km)}</b><span>km</span></div><div><b>${Math.round(s.min)}</b><span>min</span></div>${paceStat}</div>
    </a>
    ${s.alt ? `<p class="muted today-alt">ou ${sportIcon(s.alt)} ${esc(SPORTS[s.alt].label.toLowerCase())} si tu y vas</p>` : ''}
    <a class="btn primary" href="#/session/${s.id}">Voir la séance</a>
    ${canMove ? `<button class="btn ghost move-today" data-move="${s.id}">Faire cette séance aujourd'hui</button>` : ''}
  </section>`;
}

function renderToday() {
  const p = state.plan;
  const t = today();
  const daysLeft = daysBetween(t, p.profile.raceDate);
  const upcoming = allSessions().filter((s) => s.date >= t && !s.optional && !state.log[s.id]?.done && !state.log[s.id]?.skipped);
  const next = upcoming[0];
  const week = currentWeek(p, t);
  const makeup = missedKeySession(p, state.log, t);
  const missed = allSessions().filter((s) => s.date < t && !s.optional && !state.log[s.id] && s.id !== makeup?.id).slice(-3);
  const stats = recentStats(p, state.log, t);

  let weekBlock = '';
  if (week) {
    const runs = week.sessions.filter((s) => !s.optional);
    const done = runs.filter((s) => state.log[s.id]?.done);
    const weekEnd = addDays(week.start, 7);
    const free = state.freeRuns.filter((a) => a.date >= week.start && a.date < weekEnd);
    const doneKm = done.reduce((a, s) => a + (state.log[s.id].actualKm ?? s.km), 0) + free.reduce((a, r) => a + r.distanceKm, 0);
    weekBlock = `<section class="card">
      <div class="row between"><h2>Semaine ${week.index + 1}</h2><span class="phase phase-${week.phase}">${PHASES[week.phase].label}${week.recovery ? ' · allégée' : ''}</span></div>
      <div class="meter"><div style="width:${Math.min(100, (doneKm / week.volumeKm) * 100)}%"></div></div>
      <p class="muted">${doneKm.toFixed(1)} / ${week.volumeKm} km · ${done.length} / ${runs.length} courses${free.length ? ` · ${free.length} course(s) libre(s)` : ''}</p>
      <div class="week-dots">${week.sessions.map((s) => `<a href="#/session/${s.id}" class="dot ${state.log[s.id]?.done ? 'done' : s.date < t ? 'missed' : ''} ${s.date === t ? 'today' : ''}" title="${esc(s.title)}">${iconOf(s)}</a>`).join('')}</div>
    </section>`;
  }

  const fitness = p.mode === 'fitness';
  const weekNum = week ? week.index + 1 : 0;
  const hero = fitness
    ? `<div class="big">${weekNum || 1}<small>/ ${p.weeks.length}</small></div>
      <div><div class="lbl">Semaine · ${esc(p.raceLabel)}</div><div class="lbl">${week ? esc(PHASES[week.phase].label) : `Début le ${esc(dateShort(p.weeks[0].start))}`}</div></div>
      <p class="goal">${esc(p.goalText)}</p>`
    : `<div class="big">J-${daysLeft}</div>
      <div><div class="lbl">${esc(p.raceLabel)} · ${esc(dateShort(p.profile.raceDate))}</div><div class="lbl">Objectif ${duration(p.predictedGoalSec)} · ${pace(p.racePace)}/km</div></div>`;
  const finished = fitness
    ? `<section class="card"><h2>Cycle terminé</h2><p>Le cycle suivant repart de ton niveau actuel${p.profile.fitnessGoal === 'restart' ? ' : passage au mode « Courir régulièrement »' : ''}.</p><button class="btn primary" id="new-cycle">Lancer le cycle suivant</button></section>`
    : '<section class="card"><p>Plan terminé. Bravo ! Refais le questionnaire (onglet Profil) pour un nouvel objectif.</p></section>';
  const canMove = next && canMoveToToday(next, state.log, t) && painAdvice(p, state.log, t, state.painResolvedAt)?.level !== 'stop';
  view.innerHTML = `
    ${pauseBlock(t)}
    ${painBlock(t)}
    ${next ? todayHero(next, t, canMove) : finished}
    <header class="cycle-strip">${hero}</header>
    ${missed.length ? `<section class="card warn"><p><strong>${missed.length} séance(s) passée(s) sans retour.</strong> Indique si tu les as faites : c'est ce qui permet d'adapter le plan.</p>${missed.map((s) => sessionCard(s)).join('')}</section>` : ''}
    ${readinessBlock(t, next)}
    ${makeupBlock(t, makeup)}
    ${feelPrompt(t)}
    ${coachBlock(t)}
    ${loadBlock(t)}
    ${garminTodayBlock(t)}
    ${weekBlock}
    ${stats.done >= 3 && p.profile.fitnessGoal !== 'restart' ? `<section class="card"><h2>Coach</h2><p class="muted">Sur 14 jours : ${Math.round((stats.completion ?? 0) * 100)} % des séances faites, ${Math.round(stats.hardShare * 100)} % ressenties dures.</p>
      <button class="btn" id="adapt">Réajuster le plan</button></section>` : ''}
    ${p.warnings.map((w) => `<section class="card note"><p>${esc(w)}</p></section>`).join('')}`;
  view.querySelector('#adapt')?.addEventListener('click', () => doAdapt());
  view.querySelector('#new-cycle')?.addEventListener('click', newCycle);
  view.querySelector('[data-move]')?.addEventListener('click', (ev) => moveToToday(ev.currentTarget.dataset.move));
  view.querySelectorAll('[data-feel]').forEach((b) => b.addEventListener('click', () => {
    const [id, feel] = b.dataset.feel.split(':');
    state.log[id] = { ...state.log[id], feel };
    persist();
    renderToday();
    analyzePending();
  }));
  bindCoachBlocks(t, next, makeup);
  bindCareBlocks(t);
  view.querySelector('#push-week')?.addEventListener('click', () => pushWeek());
  view.querySelector('#sync-now')?.addEventListener('click', () => syncActivities(true));
  syncActivities(false).then(async () => {
    weeklyCoach();
    detectTestResults();
    await analyzePending();
    await refreshReadiness(next);
    return pushWeek({ silent: true });
  });
}

// ---------------- Coach : analyse, forme du jour, charge, rattrapage ----------------

const VERDICT = {
  success: { label: 'Réussie', icon: '✓', cls: 'ok' },
  hard: { label: 'Trop dure', icon: '↓', cls: 'bad' },
  easy: { label: 'Trop facile', icon: '↑', cls: 'up' },
  fast: { label: 'Trop rapide', icon: '⚠', cls: 'bad' },
  unknown: { label: 'Sans analyse', icon: '·', cls: '' },
};

function analysisCard(a) {
  if (!a) return '';
  const v = VERDICT[a.verdict] ?? VERDICT.unknown;
  return `<section class="card"><div class="row between"><h2>Analyse</h2><span class="verdict ${v.cls}">${v.icon} ${v.label}</span></div>
    <ul class="adj">${a.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>${a.note ? `<p class="muted">${esc(a.note)}</p>` : ''}</section>`;
}

function weekOf(date) {
  return state.plan.weeks.find((w) => w.start <= date && date < addDays(w.start, 7));
}

/** Analyse les séances faites (avec ressenti) et ajuste la suivante du même type. */
let analyzing = false;
async function analyzePending() {
  if (analyzing) return;
  analyzing = true;
  const t = today();
  let changed = false;
  let openRecap = null;
  try {
    const todo = allSessions().filter((s) => {
      const e = state.log[s.id];
      return e?.done && !e.replacedBy && !e.analysis && e.feel && s.date >= addDays(t, -10) && s.type !== 'sport' && s.type !== 'race';
    });
    for (const s of todo) {
      const e = state.log[s.id];
      let laps = null;
      if (garminOn() && e.garminId && (QUALITY_TYPES.includes(s.type) || s.type === 'long')) {
        try { ({ laps } = await api(state.garmin, 'GET', `/activities/${e.garminId}/laps`)); } catch { /* analyse au ressenti */ }
      }
      const a = analyzeSession(s, e, laps, weekOf(s.date)?.paces);
      const r = applyVerdict(state.plan, state.log, s.id, a.verdict);
      if (r.note) {
        state.plan = r.plan;
        const next = allSessions().filter((x) => x.adjustedFrom && x.type === s.type && x.date > s.date)[0];
        if (next) repushIfNeeded([next.id]);
      }
      state.log[s.id] = { ...e, ...(laps ? { laps } : {}), analysis: { verdict: a.verdict, details: a.details, note: r.note, source: a.source } };
      if (s.date >= addDays(t, -1) && !e.recapShown) openRecap = s.id;
      state.coachNotes = [{ date: s.date, id: s.id }, ...state.coachNotes.filter((n) => n.id !== s.id)].slice(0, 6);
      changed = true;
    }
  } finally {
    analyzing = false;
  }
  if (changed) {
    persist();
    const onToday = location.hash === '' || location.hash === '#/';
    // Après une séance du jour (ou d'hier) : le récap s'ouvre tout seul.
    if (openRecap && onToday) location.hash = `#/recap/${openRecap}`;
    else if (onToday) renderToday();
  }
}

function coachBlock(t) {
  const notes = state.coachNotes.filter((n) => n.date >= addDays(t, -7)).map((n) => ({ s: findSession(n.id), a: state.log[n.id]?.analysis })).filter((x) => x.s && x.a);
  if (!notes.length) return '';
  return `<section class="card"><h2>Analyse de tes séances</h2>${notes.map(({ s, a }) => {
    const v = VERDICT[a.verdict] ?? VERDICT.unknown;
    return `<a class="coach-row" href="#/recap/${s.id}"><span class="verdict ${v.cls}">${v.icon} ${v.label}</span>
      <span><strong>${esc(s.title)}</strong> <span class="muted">· ${esc(dateShort(s.date))}</span><small>${esc(frDates(a.note ?? a.details[0] ?? ''))}</small></span></a>`;
  }).join('')}</section>`;
}

const currentLoad = () => loadStatus(Object.values(state.acts), today(), state.hr);

function loadBlock(t) {
  if (!garminOn() || !Object.keys(state.acts).length) return '';
  const l = currentLoad();
  const pct = l.ratio ? Math.min(100, (l.ratio / 2) * 100) : 0;
  const warn = l.zone === 'high' || l.zone === 'elevated';
  const nextHard = allSessions().find((s) => HARD_TYPES.includes(s.type) && s.date >= t && s.date <= addDays(t, 3) && !state.log[s.id]);
  return `<section class="card ${l.zone === 'high' ? 'warn' : ''}"><div class="row between"><h2>Charge d'entraînement</h2>
      <span class="muted small">course + futsal + arbitrage</span></div>
    ${l.ratio == null ? `<p class="muted">7 derniers jours : ${Math.round(l.acute)}. Le ratio semaine / mois sera fiable après 2 semaines de données.</p>`
      : `<div class="load-gauge"><div class="zone-ok"></div><span style="left:${pct}%"></span></div>
      <p>Ratio semaine / mois : <strong>${String(l.ratio).replace('.', ',')}</strong> · ${LOAD_LABELS[l.zone]}</p>
      <p class="muted small">7 jours : ${Math.round(l.acute)} · moyenne hebdo du mois : ${l.chronic}. Zone optimale : 0,8 à 1,3.</p>`}
    ${warn && nextHard ? `<p>${l.zone === 'high' ? '⚠️ Charge trop élevée : risque de blessure accru.' : 'Charge élevée.'} Tu peux transformer « ${esc(nextHard.title)} » (${esc(dateShort(nextHard.date))}) en footing.</p>
      <button class="btn" id="load-ease" data-id="${nextHard.id}">Alléger cette séance</button>` : ''}</section>`;
}

async function refreshReadiness(next) {
  const t = today();
  if (!garminOn() || !next || next.date !== t || state.readiness?.date === t) return;
  try {
    const r = await api(state.garmin, 'GET', `/readiness?day=${t}`);
    state.readiness = { date: t, data: r, handled: false };
    persist();
    if (formClass(r) && (location.hash === '' || location.hash === '#/')) renderToday();
  } catch { /* non bloquant */ }
}

function readinessBlock(t, next) {
  const rd = state.readiness;
  if (!rd || rd.date !== t || !next || next.date !== t) return '';
  const r = rd.data;
  const advice = readinessAdvice(r, next);
  if (!advice) return '';
  const bits = [r.score != null ? `disponibilité ${r.score}/100 (${LEVEL_FR[r.level] ?? '—'})` : null,
    r.hrvStatus ? `VFC ${HRV_FR[r.hrvStatus] ?? r.hrvStatus.toLowerCase()}` : null,
    r.sleepScore != null ? `sommeil ${r.sleepScore}/100` : null,
    r.recoveryHours ? `récupération restante ${r.recoveryHours} h` : null].filter(Boolean);
  const actions = rd.handled ? '' : advice.action === 'swap' || advice.action === 'suggest'
    ? `<div class="actions"><button class="btn ghost" id="rd-keep">Garder</button><button class="btn primary" id="rd-ease">Alléger</button></div>`
    : advice.action === 'shorten' ? `<div class="actions"><button class="btn ghost" id="rd-keep">Garder</button><button class="btn primary" id="rd-short">Raccourcir</button></div>` : '';
  return `<section class="card ${advice.action === 'swap' ? 'warn' : ''}"><h2>Forme du jour</h2>
    <p class="muted">${esc(bits.join(' · '))}</p><p>${esc(advice.text)}</p>${actions}</section>`;
}

function makeupBlock(t, m) {
  if (!m) return '';
  const target = findSafeDay(state.plan, state.log, m.id, addDays(t, -1));
  return `<section class="card warn"><h2>Séance clé manquée</h2>
    <p><strong>${esc(m.title)}</strong> (${esc(dateLong(m.date))}) n'a pas été faite.</p>
    ${target ? `<p class="muted">Je peux la replacer le <strong>${esc(dateLong(target.date))}</strong> à la place du footing, sans la coller à une autre séance dure ni au lendemain d'un futsal.</p>
      <div class="actions"><button class="btn ghost" data-mk-drop="${m.id}">La laisser tomber</button><button class="btn primary" data-mk-do="${m.id}:${target.id}">La replacer</button></div>`
      : `<p class="muted">Pas de jour sûr d'ici la fin de la semaine : mieux vaut la laisser tomber que surcharger. On reprend le plan normalement.</p>
      <button class="btn" data-mk-drop="${m.id}">OK</button>`}</section>`;
}

function bindCoachBlocks(t, next) {
  view.querySelector('[data-mk-do]')?.addEventListener('click', async (ev) => {
    const [id, targetId] = ev.currentTarget.dataset.mkDo.split(':');
    const { plan, dropped } = makeUp(state.plan, state.log, id, targetId);
    state.plan = plan;
    state.log[dropped] = { skipped: true, reason: 'rattrapage', at: t };
    persist();
    if (state.pushed[dropped] && garminOn()) {
      api(state.garmin, 'DELETE', `/workouts/${encodeURIComponent(dropped)}`).catch(() => {});
      delete state.pushed[dropped];
    }
    toast('Séance replacée.');
    renderToday();
    pushWeek({ silent: true });
  });
  view.querySelector('[data-mk-drop]')?.addEventListener('click', (ev) => {
    state.log[ev.currentTarget.dataset.mkDrop] = { skipped: true, at: t };
    persist();
    renderToday();
  });
  view.querySelector('#rd-keep')?.addEventListener('click', () => { state.readiness.handled = true; persist(); renderToday(); });
  view.querySelector('#rd-ease')?.addEventListener('click', () => {
    const target = findSafeDay(state.plan, state.log, next.id, t);
    if (target) {
      const { plan } = moveSession(state.plan, next.id, target.date, state.log);
      state.plan = plan;
      toast(`Footing aujourd'hui, « ${next.title} » décalée au ${dateShort(target.date)}.`);
      repushIfNeeded([next.id, target.id]);
    } else {
      state.plan = downgradeToEasy(state.plan, next.id);
      toast('Séance transformée en footing.');
      repushIfNeeded([next.id]);
    }
    state.readiness.handled = true;
    persist();
    renderToday();
  });
  view.querySelector('#rd-short')?.addEventListener('click', () => {
    state.plan = shortenEasy(state.plan, next.id);
    state.readiness.handled = true;
    persist();
    repushIfNeeded([next.id]);
    toast('Footing raccourci.');
    renderToday();
  });
  view.querySelector('#load-ease')?.addEventListener('click', (ev) => {
    const id = ev.currentTarget.dataset.id;
    state.plan = downgradeToEasy(state.plan, id);
    persist();
    repushIfNeeded([id]);
    toast('Séance transformée en footing.');
    renderToday();
  });
}

// ---------------- Garmin ----------------

const garminOn = () => !!state.garmin?.connected;

/** Séances importées de Garmin sans ressenti : on le demande (c'est ce qui sert à adapter le plan). */
function feelPrompt(t) {
  const todo = allSessions().filter((s) => state.log[s.id]?.source === 'garmin' && !state.log[s.id].feel && s.date >= addDays(t, -7));
  if (!todo.length) return '';
  return `<section class="card"><h2>Comment c'était ?</h2>${todo.map((s) => {
    const e = state.log[s.id];
    return `<div class="feel-row"><p><strong>${esc(s.title)}</strong> <span class="muted">· ${esc(dateShort(s.date))} · ${e.actualKm} km${e.paceSecPerKm ? ` à ${pace(e.paceSecPerKm)}/km` : ''}${e.avgHr ? ` · ${e.avgHr} bpm` : ''}</span></p>
      <div class="choices">${[['easy', 'Facile'], ['ok', 'Correct'], ['hard', 'Dur']].map(([f, l]) => `<button class="btn small-btn" data-feel="${s.id}:${f}">${l}</button>`).join('')}</div></div>`;
  }).join('')}</section>`;
}

// Fenêtre d'envoi automatique : aujourd'hui + 8 jours, pour qu'un samedi la sortie longue du dimanche suivant soit couverte.
const PUSH_DAYS = 8;
const toPush = (t) => allSessions().filter((s) => !s.optional && s.date >= t && s.date <= addDays(t, PUSH_DAYS) && !state.log[s.id]?.done);

function garminTodayBlock(t) {
  if (!garminOn()) return '';
  const soon = toPush(t);
  const missing = soon.filter((s) => state.pushed[s.id]?.date !== s.date).length;
  const last = state.lastSync ? new Date(state.lastSync).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';
  return `<section class="card"><div class="row between"><h2>Garmin</h2><span class="muted small">Synchro ${last}</span></div>
    ${missing ? `<p class="muted">${missing} séance(s) des 9 prochains jours pas encore sur ta montre.</p><button class="btn primary" id="push-week">Envoyer sur ma montre</button>`
      : soon.length ? '<p class="muted">Les séances des 9 prochains jours sont sur ta montre ✓ (envoi automatique à chaque ouverture)</p>' : ''}
    <button class="btn ghost" id="sync-now">Récupérer mes courses</button>
    ${state.syncNotices?.length ? `<ul class="adj">${state.syncNotices.map((n) => `<li>${esc(frDates(n))}</li>`).join('')}</ul>` : ''}</section>`;
}

async function pushSession(s) {
  const res = await api(state.garmin, 'POST', '/workouts', sessionPayload(s));
  state.pushed[s.id] = { date: s.date, workoutId: res.workoutId };
  persist();
}

/** Renvoie les séances déjà présentes sur la montre si leur date ou leur contenu a changé. */
async function repushIfNeeded(ids) {
  if (!garminOn()) return;
  for (const id of ids) {
    const s = findSession(id);
    if (s && state.pushed[id]) {
      try { await pushSession(s); } catch (ex) { toast(`Montre non mise à jour : ${ex.message}`); }
    }
  }
}

let pushing = false;
/** Envoie sur la montre les séances des 8 prochains jours qui n'y sont pas encore (silencieux si rien à faire). */
async function pushWeek({ silent = false } = {}) {
  if (!garminOn() || pushing) return;
  await cleanup;
  const soon = toPush(today()).filter((s) => state.pushed[s.id]?.date !== s.date);
  if (!soon.length) return;
  pushing = true;
  const btn = view.querySelector('#push-week');
  if (btn) { btn.disabled = true; btn.textContent = 'Envoi en cours…'; }
  let ok = 0;
  try {
    for (const s of soon) {
      try { await pushSession(s); ok++; } catch (ex) { if (!silent) toast(ex.message); break; }
    }
  } finally {
    pushing = false;
  }
  if (ok) toast(`${ok} séance(s) envoyée(s) sur ta montre.`);
  if (location.hash === '' || location.hash === '#/') route();
}

/** Après un recalcul du plan : met à jour (ou retire) sur la montre les séances déjà envoyées. */
async function refreshPushed() {
  if (!garminOn()) return;
  const t = today();
  for (const [id, info] of Object.entries(state.pushed)) {
    if (info.date < t || state.log[id]?.done) continue; // séance déjà faite : on n'y touche plus
    const s = findSession(id);
    try {
      if (s && !s.optional) await pushSession(s);
      else { await api(state.garmin, 'DELETE', `/workouts/${encodeURIComponent(id)}`); delete state.pushed[id]; persist(); }
    } catch (ex) { toast(`Montre non mise à jour : ${ex.message}`); break; }
  }
  pushWeek({ silent: true });
}

/** Bilan automatique une fois par semaine (le lundi ou au premier lancement de la semaine). */
function weeklyCoach() {
  const p = state.plan;
  const t = today();
  if (!garminOn() || p.profile.fitnessGoal === 'restart' || onPause(t)) return;
  if ((state.lastAutoAdapt ?? '') >= mondayOf(t) || t < addDays(p.weeks[0].start, 7)) return;
  state.lastAutoAdapt = mondayOf(t);
  const { plan, adjustment } = adaptPlan(p, state.log, t, null, state.hr, currentLoad());
  state.plan = plan;
  persist();
  if (adjustment.changed || !adjustment.reasons[0].startsWith('Rien')) {
    refreshPushed();
    showSheet(`<h2>Bilan de la semaine</h2><ul>${adjustment.reasons.map((r) => `<li>${esc(frDates(r))}</li>`).join('')}</ul>
      ${adjustment.vdotAfter !== adjustment.vdotBefore ? `<p class="muted">Niveau : ${adjustment.vdotBefore} → ${adjustment.vdotAfter}</p>` : ''}
      <button class="btn primary" data-close>OK</button>`);
    route();
  }
}

/** Profil cardiaque Garmin (FC max, repos, seuil), rafraîchi une fois par jour. */
async function refreshHr(force = false) {
  if (!garminOn()) return;
  if (!force && state.hr?.at === today()) return;
  try {
    const hr = await api(state.garmin, 'GET', '/garmin/profile');
    state.hr = { ...hr, at: today() };
    persist();
  } catch { /* non bloquant */ }
}

let syncing = false;
async function syncActivities(force) {
  if (!garminOn() || syncing) return;
  if (!force && Date.now() - state.lastSync < 10 * 60 * 1000) return;
  syncing = true;
  await refreshHr();
  try {
    // 35 jours au premier passage (charge chronique sur 28 jours), puis 21 jours.
    const start = addDays(today(), Object.keys(state.acts).length ? -21 : -35);
    const { activities } = await api(state.garmin, 'GET', `/activities?start=${start}&end=${today()}`);
    for (const a of activities) {
      state.acts[a.id] = { id: a.id, date: a.date, type: a.type, name: a.name, distanceKm: a.distanceKm, durationSec: a.durationSec,
        avgHr: a.avgHr, paceSecPerKm: a.paceSecPerKm, trainingLoad: a.trainingLoad, trainingEffect: a.trainingEffect };
    }
    const oldest = addDays(today(), -180);
    for (const [id, a] of Object.entries(state.acts)) if (a.date < oldest) delete state.acts[id];
    const r = applyActivities(state.plan, state.log, activities, state.known);
    Object.assign(state, { plan: r.plan, log: r.log, known: r.known, lastSync: Date.now() });
    state.freeRuns = [...state.freeRuns, ...r.freeRuns];
    if (r.notices.length) state.syncNotices = r.notices.slice(-5);
    persist();
    if (force) toast(r.notices.length ? `${r.notices.length} course(s) importée(s).` : 'Aucune nouvelle course.');
    if (r.notices.length || force) route();
  } catch (ex) {
    if (force) toast(ex.message);
    if (/expirée|non connecté/.test(ex.message)) { state.garmin.connected = false; persist(); }
  } finally {
    syncing = false;
  }
}

function garminSessionCard(s) {
  const t = today();
  if (!garminOn()) return `<section class="card"><h2>Garmin</h2><p class="muted">Connecte ta montre dans l'onglet Profil pour envoyer cette séance.</p></section>`;
  if (state.log[s.id]?.source === 'garmin') {
    const e = state.log[s.id];
    return `<section class="card"><h2>Données Garmin</h2><p>${e.actualKm} km · ${duration(e.durationSec)}${e.paceSecPerKm ? ` · ${pace(e.paceSecPerKm)}/km` : ''}${e.avgHr ? ` · ${e.avgHr} bpm` : ''}</p></section>`;
  }
  if (s.date < t) return '';
  const p = state.pushed[s.id];
  const synced = p?.date === s.date;
  return `<section class="card"><h2>Garmin</h2>
    <p class="muted">${synced ? `Sur ta montre le ${esc(dateShort(s.date))} ✓` : 'Pas encore sur ta montre.'}</p>
    <button class="btn ${synced ? '' : 'primary'}" id="push-one">${synced ? 'Renvoyer' : 'Envoyer vers ma montre'}</button></section>`;
}

function garminProfileCard() {
  const g = state.garmin;
  if (!g?.url) {
    return `<section class="card"><h2>Montre Garmin</h2>
      <p class="muted">Colle l'adresse et la clé de ton serveur de synchronisation.</p>
      <form id="g-server"><label class="field">Adresse du serveur<input type="url" name="url" placeholder="https://…" required></label>
      <label class="field">Clé d'accès<input type="password" name="key" required autocomplete="off"></label>
      <p class="error"></p><button class="btn primary" type="submit">Enregistrer</button></form></section>`;
  }
  if (!g.connected) {
    return `<section class="card"><h2>Montre Garmin</h2>
      <p class="muted">Serveur OK. Connecte ton compte Garmin Connect (une seule fois : ton mot de passe n'est pas conservé, seul un jeton de connexion l'est).</p>
      <form id="g-login"><label class="field">E-mail Garmin<input type="email" name="email" required autocomplete="username"></label>
      <label class="field">Mot de passe Garmin<input type="password" name="password" required autocomplete="current-password"></label>
      <p class="error"></p><button class="btn primary" type="submit">Connecter mon compte</button></form>
      <form id="g-mfa" hidden><label class="field">Code reçu (e-mail ou SMS)<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code"></label>
      <p class="error"></p><button class="btn primary" type="submit">Valider le code</button></form>
      <button class="btn ghost" id="g-forget">Changer de serveur</button></section>`;
  }
  const hr = state.hr;
  return `<section class="card"><h2>Montre Garmin</h2><p>Connecté${g.name ? ` : <strong>${esc(g.name)}</strong>` : ''} ✓</p>
    ${hr?.maxHr ? `<p class="muted">Profil cardiaque Garmin : FC max ${hr.maxHr}${hr.restHr ? ` · repos ${hr.restHr}` : ''}${hr.lthr ? ` · seuil ${hr.lthr}` : ''} bpm. Il sert à juger si tes footings sont vraiment faciles.</p>`
      : '<p class="muted">Profil cardiaque pas encore récupéré (FC max / repos) : il le sera à la prochaine synchronisation.</p>'}
    <p class="muted small">Les séances des 9 prochains jours partent automatiquement sur ta montre. Chaque lundi, l'app fait le bilan de ta semaine (allure, cœur, ressenti) et ajuste la suite.</p>
    <p class="muted small">Sauvegarde serveur : ${state.lastBackup ? new Date(state.lastBackup).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) + ' ✓' : 'en attente'}</p>
    <button class="btn ghost" id="g-restore">Restaurer depuis le serveur</button>
    <button class="btn ghost" id="g-forget">Déconnecter</button></section>`;
}

function bindGarminProfile() {
  const err = (form, msg) => { form.querySelector('.error').textContent = msg; };
  view.querySelector('#g-server')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.currentTarget;
    const cfg = { url: f.url.value.trim().replace(/\/$/, ''), key: f.key.value.trim() };
    try {
      const st = await api(cfg, 'GET', '/garmin/status');
      state.garmin = { ...cfg, connected: st.connected, name: st.name };
      refreshHr(true);
      persist();
      renderProfile();
    } catch (ex) { err(f, ex.message); }
  });
  view.querySelector('#g-login')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.currentTarget;
    const btn = f.querySelector('button');
    btn.disabled = true; btn.textContent = 'Connexion…';
    try {
      const r = await api(state.garmin, 'POST', '/garmin/login', { email: f.email.value.trim(), password: f.password.value });
      f.password.value = '';
      if (r.mfa) { f.hidden = true; view.querySelector('#g-mfa').hidden = false; return; }
      state.garmin = { ...state.garmin, connected: true, name: r.name };
      persist();
      toast('Compte Garmin connecté.');
      refreshHr(true);
      renderProfile();
    } catch (ex) { err(f, ex.message); } finally { btn.disabled = false; btn.textContent = 'Connecter mon compte'; }
  });
  view.querySelector('#g-mfa')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.currentTarget;
    try {
      const r = await api(state.garmin, 'POST', '/garmin/mfa', { code: f.code.value });
      state.garmin = { ...state.garmin, connected: true, name: r.name };
      persist();
      toast('Compte Garmin connecté.');
      renderProfile();
    } catch (ex) { err(f, ex.message); }
  });
  view.querySelector('#g-forget')?.addEventListener('click', async () => {
    if (!confirm('Déconnecter Garmin de l\'app ?')) return;
    if (state.garmin?.connected) await api(state.garmin, 'POST', '/garmin/logout').catch(() => {});
    state.garmin = state.garmin?.connected ? { ...state.garmin, connected: false } : null;
    persist();
    renderProfile();
  });
}

/** Avance une séance à aujourd'hui, en vérifiant les règles de sécurité. */
function moveToToday(id) {
  const t = today();
  const s = findSession(id);
  const { plan, swappedWith, conflict, afterSport } = moveSession(state.plan, id, t, state.log);
  state.plan = plan;
  persist();
  const msgs = [`<strong>${esc(s.title)}</strong> est prévue aujourd'hui. Le ${esc(dateLong(s.date))} devient un jour de repos.`];
  if (swappedWith) msgs[0] = `<strong>${esc(s.title)}</strong> est prévue aujourd'hui, et la séance d'aujourd'hui passe au ${esc(dateLong(s.date))}.`;
  if (afterSport) msgs.push('⚠️ Tu as fait du sport intense hier : écoute tes sensations, et n\'hésite pas à lever le pied.');
  if (conflict) {
    const c = findSession(conflict);
    msgs.push(`⚠️ Demain, tu as aussi une séance dure (<strong>${esc(c.title)}</strong>). Deux séances dures d'affilée augmentent le risque de blessure.`);
    showSheet(`<h2>Séance déplacée</h2>${msgs.map((m) => `<p>${m}</p>`).join('')}
      <button class="btn primary" id="dg">Transformer celle de demain en footing</button>
      <button class="btn" data-close>Garder les deux</button>`, (sheet) => {
      sheet.querySelector('#dg').addEventListener('click', () => {
        state.plan = downgradeToEasy(state.plan, conflict);
        persist();
        repushIfNeeded([conflict]);
        closeSheet();
        toast('Séance de demain transformée en footing.');
        route();
      });
    });
  } else {
    showSheet(`<h2>Séance déplacée</h2>${msgs.map((m) => `<p>${m}</p>`).join('')}<button class="btn primary" data-close>OK</button>`);
  }
  repushIfNeeded([id, swappedWith].filter(Boolean));
  if (location.hash === `#/session/${id}`) route(); else location.hash = `#/session/${id}`;
}

function doAdapt(newRace = null) {
  const { plan, adjustment } = adaptPlan(state.plan, state.log, today(), newRace, state.hr, currentLoad());
  state.plan = plan;
  persist();
  refreshPushed();
  showSheet(`<h2>Plan réajusté</h2><ul>${adjustment.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    <button class="btn primary" data-close>OK</button>`);
  route();
}

// ---------------- Plan ----------------

function renderPlan(openIdx) {
  const t = today();
  const cur = currentWeek(state.plan, t);
  const upcoming = state.plan.weeks.find((w) => w.sessions.some((x) => x.date >= t)) ?? state.plan.weeks[0];
  const open = openIdx != null ? Number(openIdx) : (cur ?? upcoming).index;
  let lastPhase = null;
  const html = state.plan.weeks.map((w) => {
    let head = '';
    if (w.phase !== lastPhase) {
      lastPhase = w.phase;
      head = `<div class="phase-head phase-${w.phase}"><h2>${PHASES[w.phase].label}</h2><p>${esc(PHASES[w.phase].goal)}</p></div>`;
    }
    const done = w.sessions.filter((s) => !s.optional && state.log[s.id]?.done).length;
    return `${head}<details class="week ${w === cur ? 'current' : ''}" ${w.index === open ? 'open' : ''} id="w${w.index}">
      <summary><span><strong>Semaine ${w.index + 1}</strong> <span class="muted">${esc(dateShort(w.start))}</span>${w.recovery ? ' <span class="badge">allégée</span>' : ''}${w.raceWeek ? ' <span class="badge race">course</span>' : ''}</span>
      <span class="muted">${w.volumeKm} km${done ? ` · ${done}/${w.sessions.filter((s) => !s.optional).length} ✓` : ''}</span></summary>
      <div class="week-sessions">${w.sessions.map((s) => sessionCard(s)).join('')}</div>
    </details>`;
  }).join('');
  const sub = state.plan.mode === 'fitness'
    ? `${state.plan.weeks.length} semaines · ${esc(state.plan.raceLabel)}`
    : `${state.plan.weeks.length} semaines · ${esc(state.plan.raceLabel)} le ${esc(dateFull(state.plan.profile.raceDate))}`;
  view.innerHTML = `<h1>Mon plan</h1>
    <p class="muted">${sub}</p>
    <div class="volume-chart" aria-label="Volume hebdomadaire">${volumeChart()}</div>${html}`;
  if (open != null) document.getElementById(`w${open}`)?.scrollIntoView({ block: 'center' });
}

function volumeChart() {
  const weeks = state.plan.weeks;
  const max = Math.max(...weeks.map((w) => w.volumeKm));
  const cur = currentWeek(state.plan, today());
  return weeks.map((w) => `<a href="#/plan/${w.index}" class="bar phase-${w.phase} ${w === cur ? 'current' : ''}" style="height:${(w.volumeKm / max) * 100}%" title="S${w.index + 1} : ${w.volumeKm} km"></a>`).join('');
}

// ---------------- Séance ----------------

function stepsHTML(steps) {
  return `<ol class="steps">${steps.map((st) => {
    if (st.kind === 'repeat') return `<li class="repeat"><span class="times">${st.times} ×</span>${stepsHTML(st.steps)}</li>`;
    const z = st.zone ? ZONES[st.zone] : null;
    return `<li class="step kind-${st.kind}" style="--zc:${z?.color ?? 'var(--muted)'}">
      <span class="dur">${stepDuration(st.dur)}</span>
      <span class="what"><span><strong>${z ? z.label : KIND_LABEL[st.kind] ?? 'Récupération'}</strong>${st.pace ? ` <span class="pace">${paceRange(st.pace)}</span>` : ''}</span><small>${esc(st.note ?? '')}</small></span>
    </li>`;
  }).join('')}</ol>`;
}

function renderSession(id) {
  const s = findSession(id);
  if (!s) { view.innerHTML = '<p>Séance introuvable.</p>'; return; }
  const e = state.log[id] ?? {};
  const t = today();
  view.innerHTML = `
    <a href="#/plan" class="back">‹ Plan</a>
    <p class="muted">${esc(dateLong(s.date))}</p>
    <h1>${esc(s.title)}</h1>
    ${s.optional ? '<p class="big-meta">Facultatif</p>' : `<p class="big-meta">${s.km} km · ~${hm(s.min)}</p>`}
    <p>${esc(s.description)}</p>
    ${s.alt ? `<section class="card alt-note"><p><strong>${sportIcon(s.alt)} Jour de ${SPORTS[s.alt].label.toLowerCase()} possible.</strong> Tu fais <strong>l'un ou l'autre</strong>, pas les deux. Si tu vas au ${SPORTS[s.alt].label.toLowerCase()}, indique-le ci-dessous : la séance sera comptée comme remplacée.</p></section>` : ''}
    ${s.steps.length ? stepsHTML(s.steps) : ''}
    ${canMoveToToday(s, state.log, t) ? `<button class="btn move-today" data-move="${s.id}">↻ Faire cette séance aujourd'hui</button>` : ''}
    ${s.movedFrom && s.movedFrom !== s.date ? `<p class="muted small">Déplacée (prévue initialement le ${esc(dateShort(s.movedFrom))}).</p>` : ''}
    ${s.downgraded ? '<p class="muted small">Transformée en footing (récupération ou charge trop élevée).</p>' : ''}
    ${s.adjustedFrom ? `<p class="muted small">Ajustée après ta dernière séance du même type (prévue : « ${esc(s.adjustedFrom)} »).</p>` : ''}
    ${s.shortened ? '<p class="muted small">Raccourcie : forme du jour basse.</p>' : ''}
    ${analysisCard(state.log[s.id]?.analysis)}
    ${state.log[s.id]?.done && !state.log[s.id]?.replacedBy ? `<a class="btn recap-btn" href="#/recap/${s.id}">Voir le récap de la séance</a>` : ''}
    ${s.optional ? '' : garminSessionCard(s)}
    ${s.date <= t ? `<section class="card">
      <h2>Ton retour</h2>
      <form id="log-form">
        <div class="choices">
          <label class="choice small"><input type="radio" name="feel" value="easy" ${e.feel === 'easy' ? 'checked' : ''}><span>Facile</span></label>
          <label class="choice small"><input type="radio" name="feel" value="ok" ${e.feel === 'ok' ? 'checked' : ''}><span>Correct</span></label>
          <label class="choice small"><input type="radio" name="feel" value="hard" ${e.feel === 'hard' ? 'checked' : ''}><span>Dur</span></label>
        </div>
        ${s.optional ? '' : `<label class="field">Distance réelle (km)<input type="number" inputmode="decimal" step="0.1" name="km" value="${e.actualKm ?? s.km}"></label>`}
        ${s.optional ? '' : painFields(e.pain)}
        <label class="field">Note (optionnel)<input type="text" name="note" value="${esc(e.note ?? '')}" maxlength="200"></label>
        <div class="actions">
          <button type="button" class="btn ghost" id="skip">${e.skipped ? 'Annuler' : s.optional ? 'Pas cette fois' : 'Pas faite'}</button>
          <button type="submit" class="btn primary">${e.done && !e.replacedBy ? 'Mettre à jour' : s.optional ? 'J\'y suis allé' : 'Séance faite'}</button>
        </div>
        ${s.alt ? `<button type="button" class="btn alt-btn" id="replaced">${sportIcon(s.alt)} ${e.replacedBy ? `${SPORTS[s.alt].label} enregistré` : `J'ai fait du ${SPORTS[s.alt].label.toLowerCase()} à la place`}</button>` : ''}
      </form>
    </section>` : '<p class="muted center">Tu pourras saisir ton retour le jour de la séance.</p>'}`;
  const form = view.querySelector('#log-form');
  form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const feel = form.querySelector('[name=feel]:checked')?.value;
    if (!feel) { toast('Indique ton ressenti : c\'est ce qui permet d\'adapter le plan.'); return; }
    state.log[id] = { ...e, done: true, skipped: undefined, feel, actualKm: s.optional ? undefined : Number(form.km.value) || s.km, note: form.note.value.trim() || undefined, at: t, pain: readPain(form) ?? e.pain };
    persist();
    if (s.type === 'race') askRaceResult(s);
    else if (s.type === 'test') askTestResult(s);
    else { toast('Séance enregistrée 💪'); analyzePending(); history.back(); }
  });
  view.querySelector('[data-move]')?.addEventListener('click', () => moveToToday(id));
  view.querySelector('#push-one')?.addEventListener('click', async (ev) => {
    ev.currentTarget.disabled = true;
    ev.currentTarget.textContent = 'Envoi…';
    try { await pushSession(s); toast('Séance envoyée : synchronise ta montre.'); } catch (ex) { toast(ex.message); }
    renderSession(id);
  });
  view.querySelector('#replaced')?.addEventListener('click', () => {
    const feel = form.querySelector('[name=feel]:checked')?.value;
    if (!feel) { toast(`Indique ton ressenti sur le ${SPORTS[s.alt].label.toLowerCase()}.`); return; }
    state.log[id] = { done: true, replacedBy: s.alt, feel, actualKm: 0, note: form.note.value.trim() || undefined, at: t };
    persist();
    toast(`${SPORTS[s.alt].label} enregistré.`);
    history.back();
  });
  view.querySelector('#skip')?.addEventListener('click', () => {
    if (e.skipped) delete state.log[id]; else state.log[id] = { skipped: true, at: t };
    persist();
    renderSession(id);
  });
}

/** Résultat du test 6 min : distance en mètres → VMA (km/h = m / 100) → recalibrage. */
function askTestResult(s, prefill = null) {
  showSheet(`<h2>Résultat du test</h2>
    <p class="muted">${prefill ? 'Distance lue sur ta montre (tour de 6 minutes). Corrige-la si besoin.' : 'Distance parcourue pendant les 6 minutes (affichée sur ta montre).'}</p>
    <form id="tf"><label class="field">Distance en mètres<input type="number" inputmode="numeric" name="m" min="500" max="2600" value="${prefill ?? ''}" placeholder="ex. 1250" required></label>
    <p class="error"></p><button class="btn primary" type="submit">Recalibrer mes allures</button>
    <button class="btn" type="button" data-close>Plus tard</button></form>`, (sheet) => {
    sheet.querySelector('#tf').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const m = Number(ev.currentTarget.m.value);
      if (!(m >= 500 && m <= 2600)) { sheet.querySelector('.error').textContent = 'Entre 500 et 2 600 m : vérifie la saisie.'; return; }
      state.log[s.id] = { ...state.log[s.id], testDistanceM: m };
      persist();
      closeSheet();
      toast(`VMA estimée : ${(m / 100).toFixed(1).replace('.', ',')} km/h`);
      doAdapt({ distanceM: m, timeSec: 360 });
    });
  });
}

/** Test fait avec la montre : on lit le tour de 6 minutes dans l'activité Garmin. */
async function detectTestResults() {
  if (!garminOn()) return;
  const todo = allSessions().filter((s) => s.type === 'test' && state.log[s.id]?.source === 'garmin' && state.log[s.id]?.garminId && !state.log[s.id].testDistanceM && !state.log[s.id].testAsked);
  for (const s of todo) {
    state.log[s.id].testAsked = true;
    persist();
    let best = null;
    try {
      const { laps } = await api(state.garmin, 'GET', `/activities/${state.log[s.id].garminId}/laps`);
      best = laps.filter((l) => l.durationSec >= 330 && l.durationSec <= 390).sort((a, b) => b.distanceM - a.distanceM)[0];
    } catch { /* on demandera la distance à la main */ }
    const m = best ? Math.round(best.distanceM * 360 / best.durationSec) : null;
    askTestResult(s, m);
    return; // une feuille à la fois
  }
}

function askRaceResult(s) {
  showSheet(`<h2>Ton chrono ?</h2><form id="race-form">${timeFields()}<button class="btn primary" type="submit">Enregistrer</button></form>`, (sheet) => {
    sheet.querySelector('#race-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const sec = readTimeFields(sheet);
      if (sec) { state.log[s.id].timeSec = sec; persist(); toast(`Bravo : ${duration(sec)} !`); }
      closeSheet();
      location.hash = '#/';
    });
  });
}

// ---------------- Récap de séance ----------------

function renderRecap(id) {
  const s = findSession(id);
  const e = state.log[id];
  if (!s || !e?.done) { view.innerHTML = '<p>Récap indisponible.</p>'; return; }
  if (!e.recapShown) { state.log[id] = { ...e, recapShown: true }; persist(); }
  const next = allSessions().find((x) => x.date > s.date && !x.optional && !state.log[x.id]);
  const r = buildRecap(s, e, {
    paces: weekOf(s.date)?.paces,
    hr: state.hr,
    next: next ? { title: next.title, dateLabel: dateLong(next.date) } : null,
  });
  const v = VERDICT[e.analysis?.verdict] ?? null;
  const st = { ok: '✓', slow: '⚠ lent', fast: '⚠ rapide' };
  view.innerHTML = `
    <a href="#/" class="back">‹ Aujourd'hui</a>
    <p class="muted">${esc(dateLong(s.date))}${e.source === 'garmin' ? ' · données Garmin' : ''}</p>
    <div class="row between"><h1>${esc(s.title)}</h1>${v ? `<span class="verdict ${v.cls}">${v.icon} ${v.label}</span>` : ''}</div>
    <section class="card recap-conclusion"><h2>Le mot du coach</h2>${r.conclusion.map((c) => `<p>${esc(frDates(c))}</p>`).join('')}</section>
    ${r.stats.length ? `<div class="stat-grid">${r.stats.map((x) => `<div class="stat"><span class="stat-value">${esc(x.value)}</span><span class="stat-label">${esc(x.label)}</span></div>`).join('')}</div>`
      : '<section class="card note"><p>Séance saisie à la main : connecte ta montre pour avoir les chiffres détaillés.</p></section>'}
    ${r.compare.length ? `<section class="card"><h2>Prévu / réalisé</h2><table class="compare">
      ${r.compare.map((c) => `<tr><td>${esc(c.label)}</td><td class="muted">${esc(c.planned)}</td><td><strong>${esc(c.done)}</strong></td><td>${c.ok ? '✓' : '⚠'}</td></tr>`).join('')}</table></section>` : ''}
    ${r.steps ? `<section class="card"><h2>Étape par étape</h2><ol class="recap-steps">${r.steps.map((x) => `
      <li class="${x.status ?? ''}"><span><strong>${esc(x.label)}</strong> <span class="muted">${esc(x.planned)}${x.target ? ` · cible ${esc(x.target)}` : ''}</span></span>
      <span>${esc(x.actual)}${x.hr ? ` · ${x.hr} bpm` : ''} ${x.status ? `<b>${st[x.status]}</b>` : ''}</span></li>`).join('')}</ol></section>`
      : QUALITY_TYPES.includes(s.type) ? '<p class="muted small">Lance la séance depuis ta montre pour avoir le détail répétition par répétition.</p>' : ''}
    ${e.analysis?.details?.length ? `<section class="card"><h2>Analyse détaillée</h2><ul class="adj">${e.analysis.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></section>` : ''}
    <section class="card"><h2>Une douleur ?</h2>
      ${e.pain ? `<p>${e.pain.level ? `Signalée : ${esc(PAIN_LEVELS[e.pain.level])} · ${esc(PAIN_ZONES[e.pain.zone] ?? '')}` : 'Aucune douleur signalée ✓'}</p>` : '<p class="muted">Pendant ou après la séance : c\'est ce qui permet de prévenir les blessures.</p>'}
      <form id="pain-form">${painFields(e.pain)}<button class="btn" type="submit">${e.pain ? 'Mettre à jour' : 'Enregistrer'}</button></form></section>
    ${e.calories ? '<p class="muted small center">Calories : estimation Garmin (±10–20 %).</p>' : ''}`;
  view.querySelector('#pain-form')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    state.log[id] = { ...state.log[id], pain: readPain(ev.currentTarget) ?? { level: 0 } };
    persist();
    const adv = painAdvice(state.plan, state.log, today(), state.painResolvedAt);
    toast(adv && adv.level !== 'watch' ? 'Douleur notée : regarde le conseil sur l\'écran Aujourd\'hui.' : 'Merci, c\'est noté.');
    renderRecap(id);
  });
}

// ---------------- Douleur & pause ----------------

function painFields(pain) {
  const lvl = pain?.level ?? 0;
  return `<div class="pain-fields"><p class="field-label">Douleur</p>
    <div class="choices pain-levels">${Object.entries(PAIN_LEVELS).map(([v, l]) => `<label class="choice small"><input type="radio" name="painLevel" value="${v}" ${Number(v) === lvl ? 'checked' : ''}><span>${esc(l.split(' (')[0])}</span></label>`).join('')}</div>
    <label class="field pain-zone" ${lvl ? '' : 'hidden'}>Où ?<select name="painZone">${Object.entries(PAIN_ZONES).map(([k, l]) => `<option value="${k}" ${pain?.zone === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>`;
}

function readPain(form) {
  const v = form.querySelector('[name=painLevel]:checked')?.value;
  if (v == null) return null;
  const level = Number(v);
  return level ? { level, zone: form.querySelector('[name=painZone]').value } : { level: 0 };
}

// Affiche le choix de la zone dès qu'une douleur est cochée (délégation : vaut pour tous les formulaires).
document.addEventListener('change', (ev) => {
  if (ev.target.name !== 'painLevel') return;
  const zone = ev.target.closest('form, .sheet')?.querySelector('.pain-zone');
  if (zone) zone.hidden = ev.target.value === '0';
});

const onPause = (t) => state.pause && t < state.pause.until;

function pauseBlock(t) {
  if (!onPause(t)) return '';
  return `<section class="card warn"><h2>⏸ En pause</h2>
    <p>${esc(PAUSE_REASONS[state.pause.reason] ?? '')} · reprise prévue le <strong>${esc(dateLong(state.pause.until))}</strong>.</p>
    <p class="muted">Repose-toi vraiment : marche, sommeil, et pas de course « pour voir ».</p>
    <button class="btn" id="resume-now">Je reprends dès aujourd'hui</button></section>`;
}

function painBlock(t) {
  if (onPause(t)) return '';
  const adv = painAdvice(state.plan, state.log, t, state.painResolvedAt);
  if (!adv) return '';
  const cls = adv.level === 'stop' ? 'warn danger' : adv.level === 'caution' ? 'warn' : '';
  return `<section class="card ${cls}"><h2>${adv.level === 'stop' ? '🛑' : '⚠️'} Douleur : ${esc(adv.zone)}</h2><p>${esc(frDates(adv.text))}</p>
    <div class="actions wrap">
      ${adv.actions.includes('pause') ? '<button class="btn primary" id="pain-pause">Pause de 3 jours</button>' : ''}
      ${adv.actions.includes('ease') ? '<button class="btn" id="pain-ease">Alléger la prochaine séance</button>' : ''}
      <button class="btn ghost" id="pain-ok">C'est passé</button>
    </div></section>`;
}

function applyPause(days, reason) {
  const t = today();
  const r = pausePlan(state.plan, state.log, t, days, reason);
  state.plan = r.plan;
  state.pause = r.pause;
  persist();
  refreshPushed();
  showSheet(`<h2>Pause enregistrée</h2><ul>${r.adjustment.reasons.map((x) => `<li>${esc(frDates(x))}</li>`).join('')}</ul>
    <p class="muted">Les séances de la pause sont retirées de ta montre.</p><button class="btn primary" data-close>OK</button>`);
  location.hash = '#/';
  route();
}

function pauseSheet() {
  showSheet(`<h2>Faire une pause</h2>
    <form id="pz"><p class="field-label">Pourquoi ?</p>
    <div class="choices">${Object.entries(PAUSE_REASONS).map(([k, l]) => `<label class="choice small"><input type="radio" name="reason" value="${k}" ${k === 'illness' ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>
    <p class="field-label">Combien de temps ?</p>
    <div class="choices">${[3, 5, 7, 10, 14, 21].map((d) => `<label class="choice small"><input type="radio" name="days" value="${d}" ${d === 7 ? 'checked' : ''}><span>${d} jours</span></label>`).join('')}</div>
    <p class="hint">En cas de maladie : pas de course avec de la fièvre ou des symptômes sous le cou (toux, courbatures). Tu pourras reprendre plus tôt si besoin.</p>
    <button class="btn primary" type="submit">Mettre le plan en pause</button></form>`, (sheet) => {
    sheet.querySelector('#pz').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = ev.currentTarget;
      closeSheet();
      applyPause(Number(f.querySelector('[name=days]:checked').value), f.querySelector('[name=reason]:checked').value);
    });
  });
}

function bindCareBlocks(t) {
  view.querySelector('#resume-now')?.addEventListener('click', () => {
    const r = resumeEarly(state.plan, state.log, state.pause, t);
    state.plan = r.plan;
    state.pause = null;
    persist();
    refreshPushed();
    toast('Plan relancé à partir d\'aujourd\'hui, en douceur.');
    renderToday();
  });
  view.querySelector('#pain-pause')?.addEventListener('click', () => {
    state.painResolvedAt = t;
    applyPause(3, 'injury');
  });
  view.querySelector('#pain-ease')?.addEventListener('click', () => {
    const nx = allSessions().find((s) => s.date >= t && s.date <= addDays(t, 3) && !s.optional && !state.log[s.id] && s.type !== 'race');
    if (!nx) { toast('Pas de séance dans les 3 prochains jours.'); return; }
    if (HARD_TYPES.includes(nx.type) || nx.type === 'long') state.plan = downgradeToEasy(state.plan, nx.id);
    state.plan = shortenEasy(state.plan, nx.id, 0.6);
    persist();
    repushIfNeeded([nx.id]);
    toast(`« ${findSession(nx.id).title} » du ${dateShort(nx.date)} allégée.`);
    renderToday();
  });
  view.querySelector('#pain-ok')?.addEventListener('click', () => {
    state.painResolvedAt = t;
    persist();
    renderToday();
  });
}

// ---------------- Progrès ----------------

function renderProgress() {
  const t = today();
  const d = progressData(state, t);
  const lastVma = d.tests.at(-1);
  const effDelta = d.eff.length >= 4
    ? (d.eff.slice(-3).reduce((a, x) => a + x.y, 0) / 3) / (d.eff.slice(0, 3).reduce((a, x) => a + x.y, 0) / 3) - 1 : null;
  view.innerHTML = `<h1>Progrès</h1>
    <div class="tiles">
      <div class="tile"><span class="tile-value">${d.regularity == null ? '—' : Math.round(d.regularity * 100) + ' %'}</span><span class="tile-label">séances faites</span></div>
      <div class="tile"><span class="tile-value">${Math.round(d.totalKm)}</span><span class="tile-label">km courus</span></div>
      <div class="tile"><span class="tile-value">${lastVma ? lastVma.vma.toFixed(1).replace('.', ',') : '—'}</span><span class="tile-label">VMA (km/h)</span></div>
    </div>
    <section class="card"><h2>Prédiction ${esc(d.distLabel)}</h2>
      <p class="muted small">Recalculée à chaque test, chrono ou bilan. Plus haut = plus rapide.</p>
      ${lineChart(d.level, { fmt: (v) => duration(v).replace(/'00$/, ''), invert: true, empty: 'La courbe apparaîtra après ton premier recalibrage (bilan du lundi, test ou chrono).' })}</section>
    <section class="card"><h2>Efficacité en footing</h2>
      <p class="muted small">Mètres parcourus par battement de cœur. Si ça monte, tu cours plus vite pour le même effort : ton endurance progresse.${effDelta != null ? ` <strong>${effDelta >= 0 ? '+' : ''}${Math.round(effDelta * 100)} %</strong> depuis tes premiers footings.` : ''}</p>
      ${lineChart(d.eff, { fmt: (v) => v.toFixed(2).replace('.', ','), empty: 'Apparaîtra après quelques footings enregistrés avec ta montre (cardio).' })}</section>
    <section class="card"><h2>Volume par semaine</h2>
      <p class="muted small"><span class="key key-done"></span> réalisé · <span class="key key-plan"></span> prévu (km)</p>
      ${weeklyVolumeChart(d.volume)}</section>
    ${d.tests.length ? `<section class="card"><h2>Tests VMA</h2><ul class="adj">${d.tests.map((x) => `<li>${esc(dateShort(x.date))} : ${x.vma.toFixed(1).replace('.', ',')} km/h</li>`).join('')}</ul></section>` : ''}
    <div id="chart-tip" class="chart-tip" hidden></div>`;
  bindChartTips();
}

/** Valeur affichée au toucher (iPhone) ou au survol (ordinateur). */
function bindChartTips() {
  const tip = view.querySelector('#chart-tip');
  const show = (g, ev) => {
    tip.textContent = g.dataset.tip;
    tip.hidden = false;
    const r = view.getBoundingClientRect();
    const x = Math.min(Math.max(ev.clientX - r.left, 80), r.width - 80);
    tip.style.left = `${x}px`;
    tip.style.top = `${ev.clientY - r.top - 48}px`;
    view.querySelectorAll('.pt.active').forEach((n) => n.classList.remove('active'));
    g.classList.add('active');
  };
  view.querySelectorAll('.chart .pt').forEach((g) => {
    g.addEventListener('pointerenter', (ev) => show(g, ev));
    g.addEventListener('click', (ev) => show(g, ev));
  });
  view.querySelectorAll('.chart').forEach((c) => c.addEventListener('pointerleave', () => { tip.hidden = true; }));
}

// ---------------- Profil ----------------

function renderProfile() {
  const p = state.plan;
  const cur = currentWeek(p, today()) ?? p.weeks[0];
  const restart = p.profile.fitnessGoal === 'restart';
  view.innerHTML = `
    <h1>Profil & allures</h1>
    ${restart ? `<section class="card"><h2>Reprise</h2><p class="muted">Pas de chrono à ce stade : l'objectif est de courir 30 min sans s'arrêter. Les allures ci-dessous sont indicatives, fie-toi surtout à l'aisance respiratoire.</p></section>` : `<section class="card">
      <h2>Niveau actuel</h2>
      <p>VDOT <strong>${cur.vdot}</strong> <span class="muted">(départ ${p.vdotStart}, visé ${p.vdotGoal})</span></p>
      <p class="muted">Prédiction ${p.mode === 'fitness' ? 'sur 5 km' : ''} aujourd'hui : ${duration(predictTime(cur.vdot, p.profile.raceDistance))} · objectif plan : ${duration(p.predictedGoalSec)}</p>
    </section>`}
    <section class="card">
      <h2>Tes allures cette semaine</h2>
      <table class="paces">${Object.entries(cur.paces).map(([z, r]) => `<tr><td><span class="swatch" style="background:${ZONES[z].color}"></span>${ZONES[z].label}</td><td>${paceRange(r)}</td></tr>`).join('')}
        ${p.racePace ? `<tr><td><span class="swatch" style="background:${ZONES.race.color}"></span>${p.mode === 'fitness' ? 'Allure objectif 5 km' : 'Allure course'}</td><td>${pace(p.racePace)}/km</td></tr>` : ''}</table>
    </section>
    <section class="card">
      <h2>Nouveau chrono</h2>
      <p class="muted">Tu as fait une course ou un test ? Le plan se recalcule à partir de ce résultat.</p>
      <button class="btn" id="new-race">Ajouter un chrono</button>
    </section>
    ${p.adjustments.length ? `<section class="card"><h2>Historique des ajustements</h2><ul class="adj">${p.adjustments.slice().reverse().map((a) => `<li><strong>${esc(dateShort(a.date))}</strong> — ${a.reasons.map(esc).join(' ')}</li>`).join('')}</ul></section>` : ''}
    <section class="card"><h2>⏸ Pause</h2>
      <p class="muted">Maladie, blessure, vacances : le plan se suspend puis reprend en douceur au lieu de repartir comme si de rien n'était.</p>
      ${onPause(today()) ? `<p>En pause jusqu'au <strong>${esc(dateLong(state.pause.until))}</strong>.</p>` : '<button class="btn" id="pause-btn">Faire une pause</button>'}
    </section>
    ${garminProfileCard()}
    <section class="card">
      <h2>Données</h2>
      <p class="muted">${state.garmin?.url ? 'Ton plan est sauvegardé automatiquement sur ton serveur (20 dernières versions). L\'export reste possible en complément.' : 'Tout est stocké sur ton téléphone. Exporte une sauvegarde de temps en temps.'}</p>
      <div class="actions wrap">
        <button class="btn" id="export">Exporter</button>
        <label class="btn">Importer<input type="file" accept="application/json" id="import" hidden></label>
        <button class="btn" id="redo">Refaire le questionnaire</button>
      </div>
    </section>
    <p class="muted center small">Run Coach · v0.18</p>`;

  bindGarminProfile();
  view.querySelector('#pause-btn')?.addEventListener('click', pauseSheet);
  view.querySelector('#g-restore')?.addEventListener('click', () => {
    if (confirm('Remplacer le plan de ce téléphone par la dernière sauvegarde du serveur ?')) restoreSheet();
  });
  view.querySelector('#new-race').addEventListener('click', () => {
    showSheet(`<h2>Nouveau chrono</h2><form id="nr">
      <div class="choices">${[[5000, '5 km'], [10000, '10 km'], [21097, 'Semi'], [42195, 'Marathon']].map(([m, l]) => `<label class="choice small"><input type="radio" name="d" value="${m}"><span>${l}</span></label>`).join('')}</div>
      ${timeFields()}<p class="error"></p><button class="btn primary" type="submit">Recalculer le plan</button></form>`, (sheet) => {
      sheet.querySelector('#nr').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const d = Number(sheet.querySelector('[name=d]:checked')?.value);
        const sec = readTimeFields(sheet);
        if (!d || !sec) { sheet.querySelector('.error').textContent = 'Distance et temps requis.'; return; }
        const v = vdotFromPerformance(d, sec);
        if (v < 20 || v > 85) { sheet.querySelector('.error').textContent = 'Chrono incohérent, vérifie la saisie.'; return; }
        closeSheet();
        doAdapt({ distanceM: d, timeSec: sec });
      });
    });
  });
  view.querySelector('#export').addEventListener('click', () => {
    const blob = new Blob([store.exportJSON(state)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `run-coach-${today()}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  view.querySelector('#import').addEventListener('change', async (ev) => {
    try {
      state = normalize({ ...store.importJSON(await ev.target.files[0].text()), garmin: state.garmin });
      persist();
      toast('Sauvegarde restaurée.');
      route();
    } catch (ex) { toast(ex.message); }
  });
  view.querySelector('#redo').addEventListener('click', () => {
    if (!confirm('Générer un nouveau plan ? L\'historique des séances du plan actuel sera effacé.')) return;
    draft = { ...defaultDraft(), ...p.profile, mode: p.mode ?? 'race', hasRecent: !!p.profile.recent };
    if (draft.mode === 'fitness') { delete draft.raceDate; draft.raceDistance = null; }
    stepIdx = 0;
    location.hash = '#/onboarding';
  });
}

// ---------------- Feuille modale ----------------

function timeFields() {
  return `<div class="time-input">
    <label><input type="number" inputmode="numeric" min="0" name="h" placeholder="0"><span>h</span></label>
    <label><input type="number" inputmode="numeric" min="0" max="59" name="m" placeholder="00"><span>min</span></label>
    <label><input type="number" inputmode="numeric" min="0" max="59" name="s" placeholder="00"><span>s</span></label></div>`;
}

function readTimeFields(root) {
  const v = (n) => Number(root.querySelector(`[name=${n}]`).value || 0);
  const t = v('h') * 3600 + v('m') * 60 + v('s');
  return t > 0 ? t : null;
}

function showSheet(html, onMount) {
  closeSheet();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.hasAttribute('data-close')) closeSheet(); });
  document.body.append(wrap);
  onMount?.(wrap);
}

function closeSheet() {
  document.querySelector('.sheet-backdrop')?.remove();
}

// ---------------- Démarrage ----------------

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
