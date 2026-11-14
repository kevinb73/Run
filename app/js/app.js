import * as store from './store.js';
import { generatePlan, PHASES, FITNESS_GOALS, SPORTS } from './engine/plan.js';
import { adaptPlan, recentStats, currentWeek } from './engine/adapt.js';
import { canMoveToToday, moveSession, downgradeToEasy } from './engine/reschedule.js';
import { applyActivities } from './engine/garminsync.js';
import { api, sessionPayload } from './garmin.js';
import { vdotFromPerformance, predictTime } from './engine/vdot.js';
import { todayISO, daysBetween, addDays } from './engine/dates.js';
import { visibleSteps, defaultDraft } from './onboarding.js';
import { esc, pace, paceRange, duration, dateLong, dateShort, dateFull, ZONES, TYPE_ICON, stepDuration, KIND_LABEL } from './format.js';

let state = normalize(store.load());

/** Champs ajoutés au fil des versions (Garmin) : valeurs par défaut. */
function normalize(st) {
  return { garmin: null, pushed: {}, known: {}, freeRuns: [], lastSync: 0, ...st };
}

/** Nouveau plan : on garde la connexion Garmin, on retire de la montre les séances de l'ancien plan. */
function resetPlan(plan) {
  const old = state;
  state = normalize({ garmin: old.garmin, plan, log: {} });
  if (old.garmin?.connected) {
    for (const [id, info] of Object.entries(old.pushed ?? {})) {
      if (info.date >= today()) api(old.garmin, 'DELETE', `/workouts/${encodeURIComponent(id)}`).catch(() => {});
    }
  }
}
let draft = state.plan ? { ...defaultDraft(), ...state.plan.profile } : defaultDraft();
let stepIdx = 0;

const view = document.getElementById('view');
const tabbar = document.getElementById('tabbar');
const today = () => todayISO();

function persist() {
  if (!store.save(state)) toast('Impossible d\'enregistrer (stockage plein ou mode privé).');
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
    </section>`;
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

const iconOf = (s) => (s.type === 'sport' ? SPORTS[s.sport]?.icon : TYPE_ICON[s.type]) ?? '•';

// ---------------- Aujourd'hui ----------------

function sessionCard(s, { big = false } = {}) {
  const entry = state.log[s.id];
  const status = entry?.replacedBy ? `<span class="badge done">${SPORTS[entry.replacedBy].icon}</span>` : entry?.done ? '<span class="badge done">Fait</span>' : entry?.skipped ? `<span class="badge skip">${s.optional ? 'Pas fait' : 'Sautée'}</span>` : '';
  return `<a class="card session-card type-${s.type} ${big ? 'big' : ''}" href="#/session/${s.id}">
    <span class="icon" aria-hidden="true">${iconOf(s)}</span>
    <span class="body">
      <span class="date">${esc(big ? dateLong(s.date) : dateShort(s.date))}</span>
      <span class="title">${esc(s.title)}</span>
      <span class="meta">${s.optional ? 'Facultatif' : `${s.km} km · ~${duration(s.min * 60)}`}${s.alt ? ` · ou ${SPORTS[s.alt].icon} ${SPORTS[s.alt].label.toLowerCase()}` : ''}</span>
    </span>${status}</a>`;
}

function renderToday() {
  const p = state.plan;
  const t = today();
  const daysLeft = daysBetween(t, p.profile.raceDate);
  const upcoming = allSessions().filter((s) => s.date >= t && !s.optional && !state.log[s.id]?.done && !state.log[s.id]?.skipped);
  const next = upcoming[0];
  const week = currentWeek(p, t);
  const missed = allSessions().filter((s) => s.date < t && !s.optional && !state.log[s.id]).slice(-3);
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
    ? `<p class="muted">Remise en forme · ${esc(p.raceLabel)}</p>
      <div class="countdown"><strong>${weekNum || 1}</strong><span>/ ${p.weeks.length} semaines</span></div>
      ${!week && t < p.weeks[0].start ? `<p class="muted">Début le ${esc(dateLong(p.weeks[0].start))}</p>` : ''}
      <p>Objectif du cycle : <strong>${esc(p.goalText)}</strong></p>`
    : `<p class="muted">${esc(p.raceLabel)} · ${esc(dateFull(p.profile.raceDate))}</p>
      <div class="countdown"><strong>${daysLeft}</strong><span>jours</span></div>
      <p>Objectif visé : <strong>${duration(p.predictedGoalSec)}</strong> <span class="muted">(${pace(p.racePace)}/km)</span></p>`;
  const finished = fitness
    ? `<section class="card"><h2>Cycle terminé 🎉</h2><p>Le cycle suivant repart de ton niveau actuel${p.profile.fitnessGoal === 'restart' ? ' : passage au mode « Courir régulièrement »' : ''}.</p><button class="btn primary" id="new-cycle">Lancer le cycle suivant</button></section>`
    : '<section class="card"><p>Plan terminé. Bravo ! Refais le questionnaire (onglet Profil) pour un nouvel objectif.</p></section>';
  view.innerHTML = `
    <header class="hero">${hero}</header>
    ${next ? `<h2 class="section-title">${next.date === t ? 'Aujourd\'hui' : 'Prochaine séance'}</h2>${sessionCard(next, { big: true })}
      ${canMoveToToday(next, state.log, t) ? `<button class="btn ghost move-today" data-move="${next.id}">↻ Faire cette séance aujourd'hui</button>` : ''}` : finished}
    ${missed.length ? `<section class="card warn"><p><strong>${missed.length} séance(s) passée(s) sans retour.</strong> Indique si tu les as faites : c'est ce qui permet d'adapter le plan.</p>${missed.map((s) => sessionCard(s)).join('')}</section>` : ''}
    ${feelPrompt(t)}
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
  }));
  view.querySelector('#push-week')?.addEventListener('click', () => pushWeek());
  view.querySelector('#sync-now')?.addEventListener('click', () => syncActivities(true));
  syncActivities(false).then(() => pushWeek({ silent: true }));
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
  return `<section class="card"><div class="row between"><h2>⌚ Garmin</h2><span class="muted small">Synchro ${last}</span></div>
    ${missing ? `<p class="muted">${missing} séance(s) des 9 prochains jours pas encore sur ta montre.</p><button class="btn primary" id="push-week">Envoyer sur ma montre</button>`
      : soon.length ? '<p class="muted">Les séances des 9 prochains jours sont sur ta montre ✓ (envoi automatique à chaque ouverture)</p>' : ''}
    <button class="btn ghost" id="sync-now">Récupérer mes courses</button>
    ${state.syncNotices?.length ? `<ul class="adj">${state.syncNotices.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</section>`;
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
  if (ok) toast(`${ok} séance(s) envoyée(s) sur ta montre ⌚`);
  if (location.hash === '' || location.hash === '#/') route();
}

/** Après un recalcul du plan : met à jour (ou retire) sur la montre les séances déjà envoyées. */
async function refreshPushed() {
  if (!garminOn()) return;
  const t = today();
  for (const [id, info] of Object.entries(state.pushed)) {
    if (info.date < t) continue;
    const s = findSession(id);
    try {
      if (s && !s.optional) await pushSession(s);
      else { await api(state.garmin, 'DELETE', `/workouts/${encodeURIComponent(id)}`); delete state.pushed[id]; persist(); }
    } catch (ex) { toast(`Montre non mise à jour : ${ex.message}`); break; }
  }
  pushWeek({ silent: true });
}

let syncing = false;
async function syncActivities(force) {
  if (!garminOn() || syncing) return;
  if (!force && Date.now() - state.lastSync < 10 * 60 * 1000) return;
  syncing = true;
  try {
    const start = addDays(today(), -21) > state.plan.weeks[0].start ? addDays(today(), -21) : addDays(state.plan.weeks[0].start, -7);
    const { activities } = await api(state.garmin, 'GET', `/activities?start=${start}&end=${today()}`);
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
  if (!garminOn()) return `<section class="card"><h2>⌚ Garmin</h2><p class="muted">Connecte ta montre dans l'onglet Profil pour envoyer cette séance.</p></section>`;
  if (state.log[s.id]?.source === 'garmin') {
    const e = state.log[s.id];
    return `<section class="card"><h2>⌚ Données Garmin</h2><p>${e.actualKm} km · ${duration(e.durationSec)}${e.paceSecPerKm ? ` · ${pace(e.paceSecPerKm)}/km` : ''}${e.avgHr ? ` · ${e.avgHr} bpm` : ''}</p></section>`;
  }
  if (s.date < t) return '';
  const p = state.pushed[s.id];
  const synced = p?.date === s.date;
  return `<section class="card"><h2>⌚ Garmin</h2>
    <p class="muted">${synced ? `Sur ta montre le ${esc(dateShort(s.date))} ✓` : 'Pas encore sur ta montre.'}</p>
    <button class="btn ${synced ? '' : 'primary'}" id="push-one">${synced ? 'Renvoyer' : 'Envoyer vers ma montre'}</button></section>`;
}

function garminProfileCard() {
  const g = state.garmin;
  if (!g?.url) {
    return `<section class="card"><h2>⌚ Montre Garmin</h2>
      <p class="muted">Colle l'adresse et la clé de ton serveur de synchronisation.</p>
      <form id="g-server"><label class="field">Adresse du serveur<input type="url" name="url" placeholder="https://…" required></label>
      <label class="field">Clé d'accès<input type="password" name="key" required autocomplete="off"></label>
      <p class="error"></p><button class="btn primary" type="submit">Enregistrer</button></form></section>`;
  }
  if (!g.connected) {
    return `<section class="card"><h2>⌚ Montre Garmin</h2>
      <p class="muted">Serveur OK. Connecte ton compte Garmin Connect (une seule fois : ton mot de passe n'est pas conservé, seul un jeton de connexion l'est).</p>
      <form id="g-login"><label class="field">E-mail Garmin<input type="email" name="email" required autocomplete="username"></label>
      <label class="field">Mot de passe Garmin<input type="password" name="password" required autocomplete="current-password"></label>
      <p class="error"></p><button class="btn primary" type="submit">Connecter mon compte</button></form>
      <form id="g-mfa" hidden><label class="field">Code reçu (e-mail ou SMS)<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code"></label>
      <p class="error"></p><button class="btn primary" type="submit">Valider le code</button></form>
      <button class="btn ghost" id="g-forget">Changer de serveur</button></section>`;
  }
  return `<section class="card"><h2>⌚ Montre Garmin</h2><p>Connecté${g.name ? ` : <strong>${esc(g.name)}</strong>` : ''} ✓</p>
    <p class="muted small">Les séances envoyées apparaissent dans le calendrier Garmin Connect puis sur ta montre à la prochaine synchronisation.</p>
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
      toast('Compte Garmin connecté ⌚');
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
      toast('Compte Garmin connecté ⌚');
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
  const { plan, adjustment } = adaptPlan(state.plan, state.log, today(), newRace);
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
    ${s.optional ? '<p class="big-meta">Facultatif</p>' : `<p class="big-meta">${s.km} km · ~${duration(s.min * 60)}</p>`}
    <p>${esc(s.description)}</p>
    ${s.alt ? `<section class="card alt-note"><p><strong>${SPORTS[s.alt].icon} Jour de ${SPORTS[s.alt].label.toLowerCase()} possible.</strong> Tu fais <strong>l'un ou l'autre</strong>, pas les deux. Si tu vas au ${SPORTS[s.alt].label.toLowerCase()}, indique-le ci-dessous : la séance sera comptée comme remplacée.</p></section>` : ''}
    ${s.steps.length ? stepsHTML(s.steps) : ''}
    ${canMoveToToday(s, state.log, t) ? `<button class="btn move-today" data-move="${s.id}">↻ Faire cette séance aujourd'hui</button>` : ''}
    ${s.movedFrom && s.movedFrom !== s.date ? `<p class="muted small">Déplacée (prévue initialement le ${esc(dateShort(s.movedFrom))}).</p>` : ''}
    ${s.downgraded ? '<p class="muted small">Transformée en footing pour éviter deux séances dures d\'affilée.</p>' : ''}
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
        <label class="field">Note (optionnel)<input type="text" name="note" value="${esc(e.note ?? '')}" maxlength="200"></label>
        <div class="actions">
          <button type="button" class="btn ghost" id="skip">${e.skipped ? 'Annuler' : s.optional ? 'Pas cette fois' : 'Pas faite'}</button>
          <button type="submit" class="btn primary">${e.done && !e.replacedBy ? 'Mettre à jour' : s.optional ? 'J\'y suis allé' : 'Séance faite'}</button>
        </div>
        ${s.alt ? `<button type="button" class="btn alt-btn" id="replaced">${SPORTS[s.alt].icon} ${e.replacedBy ? `${SPORTS[s.alt].label} enregistré` : `J'ai fait du ${SPORTS[s.alt].label.toLowerCase()} à la place`}</button>` : ''}
      </form>
    </section>` : '<p class="muted center">Tu pourras saisir ton retour le jour de la séance.</p>'}`;
  const form = view.querySelector('#log-form');
  form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const feel = form.querySelector('[name=feel]:checked')?.value;
    if (!feel) { toast('Indique ton ressenti : c\'est ce qui permet d\'adapter le plan.'); return; }
    state.log[id] = { done: true, feel, actualKm: s.optional ? undefined : Number(form.km.value) || s.km, note: form.note.value.trim() || undefined, at: t };
    persist();
    if (s.type === 'race') askRaceResult(s);
    else { toast('Séance enregistrée 💪'); history.back(); }
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
    toast(`${SPORTS[s.alt].label} enregistré ${SPORTS[s.alt].icon}`);
    history.back();
  });
  view.querySelector('#skip')?.addEventListener('click', () => {
    if (e.skipped) delete state.log[id]; else state.log[id] = { skipped: true, at: t };
    persist();
    renderSession(id);
  });
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
    ${garminProfileCard()}
    <section class="card">
      <h2>Données</h2>
      <p class="muted">Tout est stocké sur ton téléphone. Exporte une sauvegarde de temps en temps.</p>
      <div class="actions wrap">
        <button class="btn" id="export">Exporter</button>
        <label class="btn">Importer<input type="file" accept="application/json" id="import" hidden></label>
        <button class="btn" id="redo">Refaire le questionnaire</button>
      </div>
    </section>
    <p class="muted center small">Run Coach · v0.8</p>`;

  bindGarminProfile();
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
