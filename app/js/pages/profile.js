import * as store from '../store.js';
import { SPORTS } from '../engine/plan.js';
import { currentWeek } from '../engine/adapt.js';
import { replanDays } from '../engine/replan.js';
import { vdotFromPerformance, predictTime } from '../engine/vdot.js';
import { esc, pace, paceRange, duration, dateLong, dateShort, ZONES } from '../format.js';
import { route } from '../app.js';
import { pauseSheet } from '../care.js';
import { DAY_LONG, DAY_SHORT, closeSheet, fmtDays, normalize, onPause, persist, restoreSheet, setState, showSheet, sportsSummary, state, toast, today, view } from '../core.js';
import { restartOnboarding } from './onboarding.js';
import { doAdapt } from './today.js';
import { bindGarminProfile, garminProfileCard, pushWeek, refreshPushed } from '../sync.js';
import { api } from '../garmin.js';
import { pushSupported, loadPushPrefs, enablePush, updatePushPrefs, disablePush } from '../push.js';

/** Modifier ses jours (course, sortie longue, sports, renforcement) sans refaire le plan. */
export function daysSheet() {
  const pr = state.plan.profile;
  const sports = pr.otherSports ?? [];
  const row = (name, checked) => `<div class="days">${DAY_SHORT.map((l, d) => `<label class="day"><input type="checkbox" name="${name}" value="${d}" ${checked(d) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`;
  const min = state.plan.mode === 'fitness' ? 2 : 3;
  showSheet(`<h2>Mes jours</h2>
    <p class="muted">L'historique est conservé ; seules les séances à venir sont recalculées, à partir de ton niveau actuel.</p>
    <form id="df">
      <p class="lbl">Jours de course (${min} minimum)</p>${row('run', (d) => pr.days.includes(d))}
      <label class="field">Sortie longue<select name="long">${DAY_LONG.map((l, d) => `<option value="${d}" ${d === pr.longRunDay ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${Object.keys(SPORTS).map((k) => `<p class="lbl">${esc(SPORTS[k].label)} (si tu y vas)</p>${row(`sp-${k}`, (d) => sports.some((x) => x.kind === k && x.day === d))}`).join('')}
      <label class="check"><input type="checkbox" name="strength" ${pr.strength === false ? '' : 'checked'}> Renforcement chevilles / genoux (2 × 15 min / sem.)</label>
      <p class="error"></p>
      <button class="btn primary" type="submit">Recalculer la suite du plan</button>
      <button class="btn" type="button" data-close>Annuler</button>
    </form>`, (sheet) => {
    sheet.querySelector('#df').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = ev.currentTarget;
      const vals = (n) => [...f.querySelectorAll(`[name="${n}"]:checked`)].map((i) => Number(i.value));
      const days = vals('run');
      const longRunDay = Number(f.long.value);
      const err = f.querySelector('.error');
      if (days.length < min) { err.textContent = `Choisis au moins ${min} jours de course.`; return; }
      if (!days.includes(longRunDay)) { err.textContent = 'Le jour de sortie longue doit être un jour de course.'; return; }
      const otherSports = Object.keys(SPORTS).flatMap((k) => vals(`sp-${k}`).map((day) => ({ day, kind: k })));
      try {
        const { plan, adjustment } = replanDays(state.plan, state.log, today(), { days, longRunDay, otherSports, strength: f.strength.checked });
        state.plan = plan;
        persist();
        closeSheet();
        refreshPushed().then(() => pushWeek({ silent: true }));
        toast(adjustment.reasons[0].split(' Historique')[0]);
        route();
      } catch (ex) { err.textContent = ex.message; }
    });
  });
}

export function renderProfile() {
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
    <section class="card"><h2>Mes jours</h2>
      <p class="muted">Course ${esc(fmtDays(p.profile.days))} · sortie longue le ${DAY_LONG[p.profile.longRunDay]}${(p.profile.otherSports ?? []).length ? ` · ${esc(sportsSummary(p.profile.otherSports))}` : ''} · renforcement ${p.profile.strength === false ? 'désactivé' : '2×/sem.'}</p>
      <button class="btn" id="days-btn">Modifier mes jours</button>
    </section>
    <section class="card"><h2>⏸ Pause</h2>
      <p class="muted">Maladie, blessure, vacances : le plan se suspend puis reprend en douceur au lieu de repartir comme si de rien n'était.</p>
      ${onPause(today()) ? `<p>En pause jusqu'au <strong>${esc(dateLong(state.pause.until))}</strong>.</p>` : '<button class="btn" id="pause-btn">Faire une pause</button>'}
    </section>
    ${garminProfileCard()}
    ${state.garmin?.connected ? remindersCard() : ''}
    ${state.garmin?.connected ? chatgptCard() : ''}
    <section class="card">
      <h2>Données</h2>
      <p class="muted">${state.garmin?.url ? 'Ton plan est sauvegardé automatiquement sur ton serveur (20 dernières versions). L\'export reste possible en complément.' : 'Tout est stocké sur ton téléphone. Exporte une sauvegarde de temps en temps.'}</p>
      <div class="actions wrap">
        <button class="btn" id="export">Exporter</button>
        <label class="btn">Importer<input type="file" accept="application/json" id="import" hidden></label>
        <button class="btn" id="redo">Refaire le questionnaire</button>
      </div>
    </section>
    <p class="muted center small">Run Coach · v0.51</p>`;

  bindGarminProfile();
  view.querySelector('#pause-btn')?.addEventListener('click', pauseSheet);
  view.querySelector('#days-btn')?.addEventListener('click', daysSheet);
  bindChatgpt();
  bindReminders();
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
      setState(normalize({ ...store.importJSON(await ev.target.files[0].text()), garmin: state.garmin }));
      persist();
      toast('Sauvegarde restaurée.');
      route();
    } catch (ex) { toast(ex.message); }
  });
  view.querySelector('#redo').addEventListener('click', () => {
    if (!confirm('Générer un nouveau plan ? L\'historique des séances du plan actuel sera effacé.')) return;
    restartOnboarding(p);
    location.hash = '#/onboarding';
  });
}


export function timeFields() {
  return `<div class="time-input">
    <label><input type="number" inputmode="numeric" min="0" name="h" placeholder="0"><span>h</span></label>
    <label><input type="number" inputmode="numeric" min="0" max="59" name="m" placeholder="00"><span>min</span></label>
    <label><input type="number" inputmode="numeric" min="0" max="59" name="s" placeholder="00"><span>s</span></label></div>`;
}

export function readTimeFields(root) {
  const v = (n) => Number(root.querySelector(`[name=${n}]`).value || 0);
  const t = v('h') * 3600 + v('m') * 60 + v('s');
  return t > 0 ? t : null;
}

/** Coach ChatGPT : adresse secrète du connecteur (lecture seule) et mode d'emploi. */
function chatgptCard() {
  return `<section class="card" id="gpt-card"><h2>Coach ChatGPT</h2>
    <p class="muted">ChatGPT peut lire ton plan, tes séances, ta charge et ta forme pour en discuter avec toi. Il ne lit qu'au moment où tu lui poses une question, et ne peut rien modifier.</p>
    <button class="btn" id="gpt-url">Afficher l'adresse du connecteur</button>
    <div id="gpt-out" hidden></div></section>`;
}

function bindChatgpt() {
  view.querySelector('#gpt-url')?.addEventListener('click', async (ev) => {
    const out = view.querySelector('#gpt-out');
    ev.currentTarget.disabled = true;
    try {
      const { path } = await api(state.garmin, 'GET', '/mcp-url');
      const url = state.garmin.url.replace(/\/$/, '') + path;
      out.innerHTML = `<p class="gpt-url"><code>${esc(url)}</code></p>
        <button class="btn primary" id="gpt-copy">Copier l'adresse</button>
        <ol class="gpt-steps">
          <li>Sur <strong>chatgpt.com</strong> (navigateur, pas l'app) : Paramètres → Applications / Connecteurs → Avancé → active le <strong>mode développeur</strong>.</li>
          <li>Ajoute une application / un serveur MCP personnalisé : nom « Run Coach », colle l'adresse, authentification <strong>Aucune</strong>.</li>
          <li>Dans une conversation, active « Run Coach » puis demande par exemple : « Comment s'est passée ma semaine ? »</li>
        </ol>
        <p class="muted small">⚠️ Cette adresse donne accès à tes données d'entraînement : ne la partage pas. Les menus de ChatGPT changent souvent ; si l'intitulé diffère, cherche « connecteur » ou « MCP ».</p>`;
      out.hidden = false;
      out.querySelector('#gpt-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); toast('Adresse copiée.'); } catch { toast('Copie impossible : sélectionne l\'adresse à la main.'); }
      });
    } catch (ex) {
      out.innerHTML = `<p class="error">${/404|introuvable|Not Found/i.test(ex.message) ? 'Ton serveur n\'est pas encore à jour (mise à jour automatique dans l\'heure qui suit la fusion). Réessaie un peu plus tard.' : esc(ex.message)}</p>`;
      out.hidden = false;
      ev.currentTarget.disabled = false;
    }
  });
}

/** Rappels de séance : « la veille au soir » et « le jour même », heures réglables. */
function remindersCard() {
  return `<section class="card" id="rem-card"><h2>Rappels de séance</h2>
    <p class="muted">Deux notifications possibles, chacune avec son heure : la veille au soir (anticiper) et le jour même (ne pas oublier). Rien les jours de repos.</p>
    <div id="rem-body"><button class="btn" id="rem-load">Afficher les réglages</button></div></section>`;
}

const remRow = (k, label, cfg) => `<label class="check rem-on"><input type="checkbox" name="${k}-on" ${cfg.enabled ? 'checked' : ''}> ${label}</label>
  <label class="field rem-time">Heure<input type="time" name="${k}-time" value="${esc(cfg.time)}"></label>`;

function renderReminders(prefs, msg = '') {
  const body = view.querySelector('#rem-body');
  if (!body) return;
  if (!pushSupported()) {
    body.innerHTML = '<p class="muted">Pour recevoir les rappels, ouvre l\'app depuis l\'icône de ton écran d\'accueil (pas dans Safari).</p>';
    return;
  }
  body.innerHTML = `<form id="rem-form">
    <p class="lbl">La veille au soir</p>${remRow('eve', 'Activer', prefs.eve)}
    <p class="lbl">Le jour même</p>${remRow('day', 'Activer', prefs.day)}
    <p class="error">${esc(msg)}</p>
    <button class="btn primary" type="submit">${prefs.subscribed ? 'Enregistrer' : 'Activer les rappels'}</button>
    ${prefs.subscribed ? '<button class="btn ghost" type="button" id="rem-off">Désactiver tous les rappels</button>' : ''}
  </form>`;
  body.querySelector('#rem-form').addEventListener('submit', (ev) => saveReminders(ev, prefs.subscribed));
  body.querySelector('#rem-off')?.addEventListener('click', async () => {
    try { await disablePush(); toast('Rappels désactivés.'); renderReminders({ subscribed: false, eve: prefs.eve, day: prefs.day }); }
    catch (ex) { toast(ex.message); }
  });
}

function readReminders(form) {
  return {
    eve: { enabled: form['eve-on'].checked, time: form['eve-time'].value || '20:00' },
    day: { enabled: form['day-on'].checked, time: form['day-time'].value || '07:00' },
  };
}

async function saveReminders(ev, alreadyOn) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  const prefs = readReminders(form);
  try {
    if (alreadyOn) await updatePushPrefs(prefs); else await enablePush(prefs);
    toast('Rappels enregistrés.');
    renderReminders({ subscribed: true, ...prefs });
  } catch (ex) {
    btn.disabled = false;
    form.querySelector('.error').textContent = ex.message;
  }
}

function bindReminders() {
  view.querySelector('#rem-load')?.addEventListener('click', async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      const p = pushSupported() ? await loadPushPrefs() : { eve: { enabled: true, time: '20:00' }, day: { enabled: true, time: '07:00' }, subscribed: false };
      renderReminders(p);
    } catch (ex) { toast(ex.message); ev.currentTarget.disabled = false; }
  });
}
