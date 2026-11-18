import { QUALITY_TYPES } from '../engine/analysis.js';
import { buildRecap } from '../engine/recap.js';
import { ICONS } from '../icons.js';
import { painAdvice, PAIN_ZONES, PAIN_LEVELS } from '../engine/pain.js';
import { esc, dateLong } from '../format.js';
import { VERDICT, allSessions, findSession, frDates, persist, state, toast, today, view, weekOf } from '../core.js';
import { painFields, readPain } from './session.js';

export function renderRecap(id) {
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
    <section class="card recap-conclusion"><p class="coach-head"><span class="coach-badge">${ICONS.progress}</span>Le mot du coach</p>${r.conclusion.map((c, k) => `<p class="${k === 0 ? 'coach-lead' : ''}">${esc(frDates(c))}</p>`).join('')}</section>
    ${r.stats.length ? `<div class="stat-grid">${r.stats.map((x) => `<div class="stat"><span class="stat-value">${esc(x.value)}</span><span class="stat-label">${esc(x.label)}</span></div>`).join('')}</div>`
      : '<section class="card note"><p>Séance saisie à la main : connecte ta montre pour avoir les chiffres détaillés.</p></section>'}
    ${r.compare.length ? `<section class="card"><h2>Prévu / réalisé</h2><table class="compare">
      ${r.compare.map((c) => `<tr><td>${esc(c.label)}</td><td class="muted">${esc(c.planned)}</td><td><strong>${esc(c.done)}</strong></td><td>${c.ok ? '✓' : '⚠'}</td></tr>`).join('')}</table></section>` : ''}
    ${r.steps ? `<section class="card"><h2>Étape par étape</h2><ol class="recap-steps">${r.steps.map((x) => `
      <li class="${x.status ?? ''}"><span><strong>${esc(x.label)}</strong> <span class="muted">${esc(x.planned)}${x.target ? ` · cible ${esc(x.target)}` : ''}</span></span>
      <span>${esc(x.actual)}${x.hr ? ` · ${x.hr} bpm` : ''} ${x.status ? `<b>${st[x.status]}</b>` : ''}</span></li>`).join('')}</ol></section>`
      : QUALITY_TYPES.includes(s.type) ? '<p class="muted small">Lance la séance depuis ta montre pour avoir le détail répétition par répétition.</p>' : ''}
    ${e.analysis?.details?.length ? `<section class="card"><h2>Analyse détaillée</h2><ul class="adj">${e.analysis.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></section>` : ''}
    <section class="card"><h2>Comment tu t'es senti ?</h2>
      <form id="note-form"><textarea name="note" rows="5" maxlength="2000" placeholder="Jambes lourdes au départ puis ça s'est débloqué, un peu essoufflé en côte…">${esc(e.note ?? '')}</textarea>
      <button class="btn" type="submit">${e.note ? 'Mettre à jour mon ressenti' : 'Écrire mon ressenti'}</button></form>
      <p class="muted small">Le mot du coach ci-dessus en tient compte. Pour une analyse détaillée, demande à ChatGPT : « analyse ma dernière séance ».</p></section>
    <section class="card"><h2>Une douleur ?</h2>
      ${e.pain ? `<p>${e.pain.level ? `Signalée : ${esc(PAIN_LEVELS[e.pain.level])} · ${esc(PAIN_ZONES[e.pain.zone] ?? '')}${e.pain.detail ? `<br><span class="muted">« ${esc(e.pain.detail)} »</span>` : ''}` : 'Aucune douleur signalée ✓'}</p>` : '<p class="muted">Pendant ou après la séance : c\'est ce qui permet de prévenir les blessures.</p>'}
      <form id="pain-form">${painFields(e.pain)}<button class="btn" type="submit">${e.pain ? 'Mettre à jour' : 'Enregistrer'}</button></form></section>
    ${e.calories ? '<p class="muted small center">Calories : estimation Garmin (±10–20 %).</p>' : ''}`;
  view.querySelector('#note-form')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    state.log[id] = { ...state.log[id], note: ev.currentTarget.note.value.trim() || undefined };
    persist();
    toast('Ressenti enregistré : le coach en tient compte.');
    renderRecap(id);
  });
  view.querySelector('#pain-form')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    state.log[id] = { ...state.log[id], pain: readPain(ev.currentTarget) ?? { level: 0 } };
    persist();
    const adv = painAdvice(state.plan, state.log, today(), state.painResolvedAt);
    toast(adv && adv.level !== 'watch' ? 'Douleur notée : regarde le conseil sur l\'écran Aujourd\'hui.' : 'Merci, c\'est noté.');
    renderRecap(id);
  });
}
