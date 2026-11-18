import { SPORTS } from '../engine/plan.js';
import { canMoveToToday, unavailableOptions, moveSession, moveStrength, strengthMoveOptions } from '../engine/reschedule.js';
import { PAIN_ZONES, PAIN_LEVELS } from '../engine/pain.js';
import { easyHrCeiling } from '../engine/coach.js';
import { esc, pace, paceRange, duration, dateLong, dateShort, ZONES, stepDuration, KIND_LABEL, hm } from '../format.js';
import { analysisCard, closeSheet, findSession, persist, showSheet, sportIcon, state, toast, today, view } from '../core.js';
import { readTimeFields, timeFields } from './profile.js';
import { alreadyRan, doAdapt, moveToToday } from './today.js';
import { analyzePending, garminSessionCard, pushSession, repushIfNeeded } from '../sync.js';
import { route } from '../app.js';

export function stepsHTML(steps) {
  return `<ol class="steps">${steps.map((st) => {
    if (st.kind === 'repeat') return `<li class="repeat"><span class="times">${st.times} ×</span>${stepsHTML(st.steps)}</li>`;
    if (st.kind === 'strength') return `<li class="step kind-strength" style="--zc:var(--accent)">
      <span class="dur">${st.sets} × ${st.work} s</span>
      <span class="what"><span><strong>${esc(st.name)}</strong> <span class="pace">récup ${st.rest} s</span></span><small>${esc(st.note ?? '')}</small></span>
    </li>`;
    const z = st.zone ? ZONES[st.zone] : null;
    return `<li class="step kind-${st.kind}" style="--zc:${z?.color ?? 'var(--muted)'}">
      <span class="dur">${stepDuration(st.dur)}</span>
      <span class="what"><span><strong>${z ? z.label : KIND_LABEL[st.kind] ?? 'Récupération'}</strong>${st.pace ? ` <span class="pace">${paceRange(st.pace)}</span>` : ''}</span><small>${esc(st.note ?? '')}</small></span>
    </li>`;
  }).join('')}</ol>`;
}

export function renderSession(id) {
  const s = findSession(id);
  if (!s) { view.innerHTML = '<p>Séance introuvable.</p>'; return; }
  const e = state.log[id] ?? {};
  const t = today();
  // Sport (séance futsal/arbitrage, ou jour « course OU sport ») : durée saisissable si pas de montre.
  const sportKind = s.type === 'sport' ? s.sport : s.alt ?? null;
  view.innerHTML = `
    <a href="#/plan" class="back">‹ Plan</a>
    <p class="muted">${esc(dateLong(s.date))}</p>
    <h1>${esc(s.title)}</h1>
    ${s.optional ? '<p class="big-meta">Facultatif</p>' : `<p class="big-meta">${s.km} km · ~${hm(s.min)}</p>`}
    <p>${esc(s.description)}</p>
    ${s.alt ? `<section class="card alt-note"><p><strong>${sportIcon(s.alt)} Jour de ${SPORTS[s.alt].label.toLowerCase()} possible.</strong> Tu fais <strong>l'un ou l'autre</strong>, pas les deux. Si tu vas au ${SPORTS[s.alt].label.toLowerCase()}, indique-le ci-dessous : la séance sera comptée comme remplacée.</p></section>` : ''}
    ${s.steps.length ? stepsHTML(s.steps) : ''}
    ${['easy', 'long'].includes(s.type) && easyHrCeiling(state.hr) ? `<p class="muted small hr-cue">💓 Zone facile : garde ton cœur <strong>sous ~${easyHrCeiling(state.hr).bpm} bpm</strong>. C'est en restant vraiment facile que tu construis l'endurance — quitte à marcher quelques secondes si ça monte.</p>` : ''}
    ${canMoveToToday(s, state.log, t) && !alreadyRan(t) ? `<button class="btn move-today" data-move="${s.id}">↻ Faire cette séance aujourd'hui</button>` : ''}
    ${!s.optional && s.date >= t && !state.log[s.id] && s.type !== 'race' ? '<button class="btn ghost move-today" id="unavail">Pas dispo ce jour-là</button>' : ''}
    ${s.type === 'strength' && !state.log[s.id]?.done && !state.log[s.id]?.skipped && s.date >= t ? '<button class="btn ghost" id="postpone-strength">Reporter à un autre jour</button>' : ''}
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
        ${sportKind ? `<label class="field">Durée ${sportKind === 'referee' ? 'de l\'arbitrage' : `du ${esc(SPORTS[sportKind].label.toLowerCase())}`} (min)<small class="muted"> · sans montre, compte dans ta charge</small><input type="number" inputmode="numeric" name="sportMin" min="0" max="300" value="${e.sportMin ?? ''}" placeholder="ex. 60"></label>` : ''}
        ${s.optional ? '' : `<label class="field">Distance réelle (km)<input type="number" inputmode="decimal" step="0.1" name="km" value="${e.actualKm ?? s.km}"></label>`}
        ${s.optional ? '' : painFields(e.pain)}
        <label class="field">Comment tu t'es senti ? <small class="muted">(optionnel · ton coach en tient compte)</small>
          <textarea name="note" rows="5" maxlength="400" placeholder="Jambes lourdes au départ puis ça s'est débloqué, un peu essoufflé en côte…">${esc(e.note ?? '')}</textarea></label>
        <div class="actions">
          <button type="button" class="btn ghost" id="skip">${e.skipped ? 'Annuler' : s.optional ? 'Pas cette fois' : 'Pas faite'}</button>
          <button type="submit" class="btn primary">${e.done && !e.replacedBy ? 'Mettre à jour' : s.type === 'strength' ? 'C\'est fait' : s.optional ? 'J\'y suis allé' : 'Séance faite'}</button>
        </div>
        ${s.alt ? `<button type="button" class="btn alt-btn" id="replaced">${sportIcon(s.alt)} ${e.replacedBy ? `${SPORTS[s.alt].label} enregistré` : `J'ai fait du ${SPORTS[s.alt].label.toLowerCase()} à la place`}</button>` : ''}
      </form>
    </section>` : '<p class="muted center">Tu pourras saisir ton retour le jour de la séance.</p>'}`;
  const form = view.querySelector('#log-form');
  form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const feel = form.querySelector('[name=feel]:checked')?.value;
    if (!feel) { toast('Indique ton ressenti : c\'est ce qui permet d\'adapter le plan.'); return; }
    state.log[id] = { ...e, done: true, skipped: undefined, feel, actualKm: s.optional ? undefined : Number(form.km.value) || s.km, note: form.note.value.trim() || undefined, at: t, pain: readPain(form) ?? e.pain, ...(s.optional ? { sportMin: readSportMin(form) } : {}) };
    persist();
    if (s.type === 'race') askRaceResult(s);
    else if (s.type === 'test') askTestResult(s);
    else { toast('Séance enregistrée 💪'); analyzePending(); history.back(); }
  });
  view.querySelector('[data-move]')?.addEventListener('click', () => moveToToday(id));
  view.querySelector('#unavail')?.addEventListener('click', () => unavailableSheet(s));
  view.querySelector('#postpone-strength')?.addEventListener('click', () => postponeStrengthSheet(s));
  view.querySelector('#push-one')?.addEventListener('click', async (ev) => {
    ev.currentTarget.disabled = true;
    ev.currentTarget.textContent = 'Envoi…';
    try { await pushSession(s); toast('Séance envoyée : synchronise ta montre.'); } catch (ex) { toast(ex.message); }
    renderSession(id);
  });
  view.querySelector('#replaced')?.addEventListener('click', () => {
    const feel = form.querySelector('[name=feel]:checked')?.value;
    if (!feel) { toast(`Indique ton ressenti sur le ${SPORTS[s.alt].label.toLowerCase()}.`); return; }
    state.log[id] = { done: true, replacedBy: s.alt, feel, actualKm: 0, note: form.note.value.trim() || undefined, at: t, sportMin: readSportMin(form) };
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
export function askTestResult(s, prefill = null) {
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

export function askRaceResult(s) {
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


export function painFields(pain) {
  const lvl = pain?.level ?? 0;
  return `<div class="pain-fields"><p class="field-label">Douleur</p>
    <div class="choices pain-levels">${Object.entries(PAIN_LEVELS).map(([v, l]) => `<label class="choice small"><input type="radio" name="painLevel" value="${v}" ${Number(v) === lvl ? 'checked' : ''}><span>${esc(l.split(' (')[0])}</span></label>`).join('')}</div>
    <label class="field pain-zone" ${lvl ? '' : 'hidden'}>Où ?<select name="painZone">${Object.entries(PAIN_ZONES).map(([k, l]) => `<option value="${k}" ${pain?.zone === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <label class="field pain-zone" ${lvl ? '' : 'hidden'}>Détails <small class="muted">(optionnel · ton coach et ChatGPT en tiennent compte pour adapter)</small><textarea name="painDetail" rows="2" maxlength="300" placeholder="Ex. tiraillement mollet droit au départ, part après 10 min ; gêne genou en descente…">${esc(pain?.detail ?? '')}</textarea></label></div>`;
}

/** Durée saisie pour un sport sans montre (minutes), ou undefined. */
export function readSportMin(form) {
  const v = Number(form.querySelector('[name=sportMin]')?.value);
  return v > 0 ? Math.min(300, Math.round(v)) : undefined;
}

export function readPain(form) {
  const v = form.querySelector('[name=painLevel]:checked')?.value;
  if (v == null) return null;
  const level = Number(v);
  if (!level) return { level: 0 };
  const detail = form.querySelector('[name=painDetail]')?.value.trim();
  return { level, zone: form.querySelector('[name=painZone]').value, ...(detail ? { detail } : {}) };
}

/** « Pas dispo ce jour-là » : propose les meilleurs jours de la semaine, ou de la sauter. */
function unavailableSheet(s) {
  const opts = unavailableOptions(state.plan, state.log, s.id, today());
  showSheet(`<h2>Pas dispo le ${esc(dateLong(s.date))}</h2>
    <p class="muted">${opts.length ? 'Meilleurs jours pour la caser cette semaine :' : 'Aucun jour sûr cette semaine pour cette séance.'}</p>
    ${opts.map((o) => `<button class="btn ${o === opts[0] ? 'primary' : ''} unav-opt" data-date="${o.date}">${esc(o.label[0].toUpperCase() + o.label.slice(1))} ${esc(dateShort(o.date).replace(/^\S+ /, ''))}${o.note ? `<small class="muted">${esc(o.note)}</small>` : ''}</button>`).join('')}
    <button class="btn ghost" id="unav-skip">${opts.length ? 'Non, je la saute cette semaine' : 'La sauter cette semaine'}</button>
    <button class="btn" data-close>Annuler</button>`, (sheet) => {
    sheet.querySelectorAll('.unav-opt').forEach((b) => b.addEventListener('click', () => {
      const { plan } = moveSession(state.plan, s.id, b.dataset.date, state.log);
      state.plan = plan;
      persist();
      repushIfNeeded([s.id]);
      closeSheet();
      toast(`Séance déplacée au ${dateLong(b.dataset.date)}.`);
      route();
    }));
    sheet.querySelector('#unav-skip').addEventListener('click', () => {
      state.log[s.id] = { skipped: true, at: today(), reason: 'unavailable' };
      persist();
      closeSheet();
      toast('Séance sautée : le plan en tient compte au prochain bilan.');
      route();
    });
  });
}

function postponeStrengthSheet(s) {
  const opts = strengthMoveOptions(state.plan, state.log, s.id, today());
  if (!opts.length) { toast('Aucun autre jour disponible pour le renforcement.'); return; }
  showSheet(`<h2>Reporter le renforcement</h2>
    <p class="muted">Choisis le nouveau jour. Ta course n'est pas touchée : le renfo peut se faire le même jour qu'un footing.</p>
    ${opts.map((d, i) => `<button class="btn ${i === 0 ? 'primary' : ''} str-opt" data-date="${d}">${esc(dateLong(d)[0].toUpperCase() + dateLong(d).slice(1))}</button>`).join('')}
    <button class="btn ghost" data-close>Annuler</button>`, (sheet) => {
    sheet.querySelectorAll('.str-opt').forEach((b) => b.addEventListener('click', () => {
      state.plan = moveStrength(state.plan, s.id, b.dataset.date);
      persist();
      repushIfNeeded([s.id]);
      closeSheet();
      toast(`Renforcement reporté au ${dateLong(b.dataset.date)}.`);
      renderSession(s.id);
    }));
  });
}
