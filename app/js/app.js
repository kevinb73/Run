import * as store from './store.js';
import { generatePlan, PHASES, FITNESS_GOALS, SPORTS } from './engine/plan.js';
import { adaptPlan, recentStats, currentWeek } from './engine/adapt.js';
import { vdotFromPerformance, predictTime } from './engine/vdot.js';
import { todayISO, daysBetween } from './engine/dates.js';
import { visibleSteps, defaultDraft } from './onboarding.js';
import { esc, pace, paceRange, duration, dateLong, dateShort, dateFull, ZONES, TYPE_ICON, stepDuration, KIND_LABEL } from './format.js';

let state = store.load();
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
      state = { plan: generatePlan(profile, { today: today() }), log: {} };
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
  state = { plan: generatePlan(prof, { today: today() }), log: {} };
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
    const doneKm = done.reduce((a, s) => a + (state.log[s.id].actualKm ?? s.km), 0);
    weekBlock = `<section class="card">
      <div class="row between"><h2>Semaine ${week.index + 1}</h2><span class="phase phase-${week.phase}">${PHASES[week.phase].label}${week.recovery ? ' · allégée' : ''}</span></div>
      <div class="meter"><div style="width:${Math.min(100, (doneKm / week.volumeKm) * 100)}%"></div></div>
      <p class="muted">${doneKm.toFixed(1)} / ${week.volumeKm} km · ${done.length} / ${runs.length} courses</p>
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
    ${next ? `<h2 class="section-title">${next.date === t ? 'Aujourd\'hui' : 'Prochaine séance'}</h2>${sessionCard(next, { big: true })}` : finished}
    ${missed.length ? `<section class="card warn"><p><strong>${missed.length} séance(s) passée(s) sans retour.</strong> Indique si tu les as faites : c'est ce qui permet d'adapter le plan.</p>${missed.map((s) => sessionCard(s)).join('')}</section>` : ''}
    ${weekBlock}
    ${stats.done >= 3 && p.profile.fitnessGoal !== 'restart' ? `<section class="card"><h2>Coach</h2><p class="muted">Sur 14 jours : ${Math.round((stats.completion ?? 0) * 100)} % des séances faites, ${Math.round(stats.hardShare * 100)} % ressenties dures.</p>
      <button class="btn" id="adapt">Réajuster le plan</button></section>` : ''}
    ${p.warnings.map((w) => `<section class="card note"><p>${esc(w)}</p></section>`).join('')}`;
  view.querySelector('#adapt')?.addEventListener('click', () => doAdapt());
  view.querySelector('#new-cycle')?.addEventListener('click', newCycle);
}

function doAdapt(newRace = null) {
  const { plan, adjustment } = adaptPlan(state.plan, state.log, today(), newRace);
  state.plan = plan;
  persist();
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
    ${s.optional ? '' : `<section class="card">
      <h2>Garmin</h2>
      <p class="muted">L'envoi direct vers la montre arrive à l'étape 2 (serveur de synchronisation).</p>
      <button class="btn" disabled>Envoyer vers ma montre</button>
    </section>`}
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
    <section class="card">
      <h2>Données</h2>
      <p class="muted">Tout est stocké sur ton téléphone. Exporte une sauvegarde de temps en temps.</p>
      <div class="actions wrap">
        <button class="btn" id="export">Exporter</button>
        <label class="btn">Importer<input type="file" accept="application/json" id="import" hidden></label>
        <button class="btn" id="redo">Refaire le questionnaire</button>
      </div>
    </section>
    <p class="muted center small">Run Coach · v0.4</p>`;

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
      state = store.importJSON(await ev.target.files[0].text());
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
