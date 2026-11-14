import { adaptPlan } from './engine/adapt.js';
import { applyActivities } from './engine/garminsync.js';
import { analyzeSession, applyVerdict, QUALITY_TYPES } from './engine/analysis.js';
import { applyEasyFeedback } from './engine/easyfeedback.js';
import { api, sessionPayload } from './garmin.js';
import { addDays, mondayOf } from './engine/dates.js';
import { esc, pace, duration, dateShort } from './format.js';
import { route } from './app.js';
import { allSessions, cleanup, findSession, frDates, garminOn, isRunType, onPause, persist, showSheet, state, toast, today, view, weekOf } from './core.js';
import { renderProfile } from './pages/profile.js';
import { askTestResult } from './pages/session.js';
import { currentLoad, renderToday } from './pages/today.js';

/** Analyse les séances faites (avec ressenti) et ajuste la suivante du même type. */
export let analyzing = false;
export async function analyzePending() {
  if (analyzing) return;
  analyzing = true;
  const t = today();
  let changed = false;
  let openRecap = null;
  try {
    const todo = allSessions().filter((s) => {
      const e = state.log[s.id];
      return e?.done && !e.replacedBy && !e.analysis && e.feel && s.date >= addDays(t, -10) && isRunType(s) && s.type !== 'race';
    });
    for (const s of todo) {
      const e = state.log[s.id];
      let laps = null;
      if (garminOn() && e.garminId && (QUALITY_TYPES.includes(s.type) || s.type === 'long')) {
        try { ({ laps } = await api(state.garmin, 'GET', `/activities/${e.garminId}/laps`)); } catch { /* analyse au ressenti */ }
      }
      const a = analyzeSession(s, e, laps, weekOf(s.date)?.paces);
      let r = applyVerdict(state.plan, state.log, s.id, a.verdict);
      if (r.note) {
        state.plan = r.plan;
        const next = allSessions().filter((x) => x.adjustedFrom && x.type === s.type && x.date > s.date)[0];
        if (next) repushIfNeeded([next.id]);
      } else {
        // Footing / sortie longue : le footing suivant (≤ 3 jours) est allégé si la séance a été dure.
        r = applyEasyFeedback(state.plan, state.log, s.id, state.hr);
        if (r.note) { state.plan = r.plan; repushIfNeeded([r.nextId]); }
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

// Fenêtre d'envoi automatique : aujourd'hui + 8 jours, pour qu'un samedi la sortie longue du dimanche suivant soit couverte.
export const PUSH_DAYS = 8;
export const toPush = (t) => allSessions().filter((s) => (!s.optional || s.type === 'strength') && s.date >= t && s.date <= addDays(t, PUSH_DAYS) && !state.log[s.id]?.done);

export async function pushSession(s) {
  const res = await api(state.garmin, 'POST', '/workouts', sessionPayload(s));
  state.pushed[s.id] = { date: s.date, workoutId: res.workoutId };
  persist();
}

/** Renvoie les séances déjà présentes sur la montre si leur date ou leur contenu a changé. */
export async function repushIfNeeded(ids) {
  if (!garminOn()) return;
  for (const id of ids) {
    const s = findSession(id);
    if (s && state.pushed[id]) {
      try { await pushSession(s); } catch (ex) { toast(`Montre non mise à jour : ${ex.message}`); }
    }
  }
}

export let pushing = false;
/** Envoie sur la montre les séances des 8 prochains jours qui n'y sont pas encore (silencieux si rien à faire). */
const pushFailed = new Set();

/** Séances des prochains jours pas encore sur la montre (hors envois refusés pendant cette ouverture de l'app). */
export const pendingPush = (t) => toPush(t).filter((s) => state.pushed[s.id]?.date !== s.date && !pushFailed.has(`${s.id}@${s.date}`));

export async function pushWeek({ silent = false, retry = false } = {}) {
  if (retry) pushFailed.clear(); // bouton « Envoyer » : on retente tout
  if (!garminOn() || pushing) return;
  await cleanup;
  // Une séance refusée par le serveur n'est pas retentée avant la prochaine ouverture de l'app (évite toute boucle).
  const soon = toPush(today()).filter((s) => state.pushed[s.id]?.date !== s.date && !pushFailed.has(`${s.id}@${s.date}`));
  if (!soon.length) return;
  pushing = true;
  const btn = view.querySelector('#push-week');
  if (btn) { btn.disabled = true; btn.textContent = 'Envoi en cours…'; }
  let ok = 0;
  try {
    for (const s of soon) {
      try { await pushSession(s); ok++; } catch (ex) {
        pushFailed.add(`${s.id}@${s.date}`);
        if (s.type === 'strength') continue; // serveur pas encore à jour pour le renfo : on n'empêche pas l'envoi des courses
        if (!silent) toast(ex.message); break;
      }
    }
  } finally {
    pushing = false;
  }
  if (!ok) {
    // Rien d'envoyé : on rend le bouton (sans réafficher l'écran, ce qui relancerait l'envoi en boucle).
    if (btn?.isConnected) { btn.disabled = false; btn.textContent = 'Envoyer sur ma montre'; }
    if (!silent) toast('Envoi impossible pour le moment (serveur en cours de mise à jour ?). Réessaie plus tard.');
    return;
  }
  toast(`${ok} séance(s) envoyée(s) sur ta montre.`);
  if (location.hash === '' || location.hash === '#/') route();
}

/** Après un recalcul du plan : met à jour (ou retire) sur la montre les séances déjà envoyées. */
/** Séance faite en avance (ou remplacée) : on la retire du calendrier de la montre à sa date d'origine. */
export async function removeDoneAhead() {
  if (!garminOn()) return;
  const t = today();
  for (const [id, info] of Object.entries(state.pushed)) {
    const e = state.log[id];
    if (!e?.done || info.date < t) continue;
    const doneOn = e.at ?? t;
    if (doneOn >= info.date) continue; // faite le jour prévu : rien à retirer
    try { await api(state.garmin, 'DELETE', `/workouts/${encodeURIComponent(id)}`); delete state.pushed[id]; persist(); }
    catch { break; } // hors ligne : on réessaiera à la prochaine synchro
  }
}

export async function refreshPushed() {
  if (!garminOn()) return;
  const t = today();
  await removeDoneAhead();
  for (const [id, info] of Object.entries(state.pushed)) {
    if (info.date < t || state.log[id]?.done) continue; // séance déjà faite : on n'y touche plus
    const s = findSession(id);
    try {
      if (s && (!s.optional || s.type === 'strength')) await pushSession(s);
      else { await api(state.garmin, 'DELETE', `/workouts/${encodeURIComponent(id)}`); delete state.pushed[id]; persist(); }
    } catch (ex) { toast(`Montre non mise à jour : ${ex.message}`); break; }
  }
  pushWeek({ silent: true });
}

/** Bilan automatique une fois par semaine (le lundi ou au premier lancement de la semaine). */
export function weeklyCoach() {
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
export async function refreshHr(force = false) {
  if (!garminOn()) return;
  if (!force && state.hr?.at === today()) return;
  try {
    const hr = await api(state.garmin, 'GET', '/garmin/profile');
    state.hr = { ...hr, at: today() };
    persist();
  } catch { /* non bloquant */ }
}

export let syncing = false;
export async function syncActivities(force) {
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
        avgHr: a.avgHr, paceSecPerKm: a.paceSecPerKm, trainingLoad: a.trainingLoad, trainingEffect: a.trainingEffect,
        calories: a.calories ?? undefined, elevationGainM: a.elevationGainM ?? undefined, maxHr: a.maxHr ?? undefined };
    }
    const oldest = addDays(today(), -180);
    for (const [id, a] of Object.entries(state.acts)) if (a.date < oldest) delete state.acts[id];
    const r = applyActivities(state.plan, state.log, activities, state.known);
    Object.assign(state, { plan: r.plan, log: r.log, known: r.known, lastSync: Date.now() });
    state.freeRuns = [...state.freeRuns, ...r.freeRuns];
    if (r.notices.length) state.syncNotices = r.notices.slice(-5);
    persist();
    removeDoneAhead();
    if (force) toast(r.notices.length ? `${r.notices.length} course(s) importée(s).` : 'Aucune nouvelle course.');
    if (r.notices.length || force) route();
  } catch (ex) {
    if (force) toast(ex.message);
    if (/expirée|non connecté/.test(ex.message)) { state.garmin.connected = false; persist(); }
  } finally {
    syncing = false;
  }
}

export function garminSessionCard(s) {
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

export function garminProfileCard() {
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

export function bindGarminProfile() {
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

/** Test fait avec la montre : on lit le tour de 6 minutes dans l'activité Garmin. */
export async function detectTestResults() {
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
