import { PHASES, SPORTS } from '../engine/plan.js';
import { adaptPlan, recentStats, currentWeek } from '../engine/adapt.js';
import { canAddBonus, addBonus, suggestedBonusKm, canMoveToToday, moveSession, movableToToday, downgradeToEasy, findSafeDay, missedKeySession, makeUp, shortenEasy, HARD_TYPES } from '../engine/reschedule.js';
import { loadStatus, manualActivities, LOAD_LABELS } from '../engine/load.js';
import { readinessAdvice, readinessNeedsRefresh, formClass, LEVEL_FR, HRV_FR } from '../engine/readiness.js';
import { api } from '../garmin.js';
import { buildRecap } from '../engine/recap.js';
import { painAdvice } from '../engine/pain.js';
import { daysBetween, addDays } from '../engine/dates.js';
import { esc, pace, duration, dateLong, dateShort } from '../format.js';
import { route } from '../app.js';
import { bindCareBlocks, painBlock, pauseBlock } from '../care.js';
import { VERDICT, allSessions, closeSheet, findSession, frDates, garminOn, iconOf, isRunType, onPause, persist, sessionCard, showSheet, sportIcon, state, toast, today, view, weekOf } from '../core.js';
import { newCycle } from './onboarding.js';
import { celebrationCard, bindCelebration } from '../achievements.js';
import { proposalsCard, bindProposals, fetchProposals } from '../proposals.js';
import { analyzePending, detectTestResults, pushWeek, refreshPushed, repushIfNeeded, syncActivities, toPush, weeklyCoach } from '../sync.js';

/** Grand bloc « séance du jour » : ce qu'on doit voir en premier en ouvrant l'app. */
/** Déjà couru aujourd'hui (séance du plan, bonus ou course libre) : on ne propose pas une 2e course. */
export function alreadyRan(t) {
  return allSessions().some((x) => x.date === t && isRunType(x) && state.log[x.id]?.done && !state.log[x.id]?.replacedBy)
    || state.freeRuns.some((r) => r.date === t);
}

/** Renforcement du jour (facultatif) : petite carte sous la séance. */
export function strengthToday(t) {
  const s = allSessions().find((x) => x.date === t && x.type === 'strength');
  if (!s) return '';
  const e = state.log[s.id];
  return `<section class="card strength-card"><a class="next-link" href="#/session/${s.id}"><span class="icon">${iconOf(s)}</span>
    <span><strong>Renforcement · ~${s.min} min</strong><small class="muted">${e?.done ? 'Fait ✓' : esc(s.description.split('. ').slice(0, 1).join(''))} · chevilles, genoux, hanches</small></span></a></section>`;
}

/** Première phrase du mot du coach (récap) pour une séance faite. */
export function coachLine(s, e) {
  if (!e?.analysis && !e?.feel) return null;
  try { return buildRecap(s, e, { paces: weekOf(s.date)?.paces, hr: state.hr, next: null }).conclusion[0] ?? null; } catch { return null; }
}

/** Haut de l'écran quand rien n'est à faire aujourd'hui : séance faite (résumé) ou repos. */
export function todayState(t) {
  const done = allSessions().filter((x) => x.date === t && isRunType(x) && state.log[x.id]?.done && !state.log[x.id]?.replacedBy);
  const sport = allSessions().find((x) => x.date === t && x.type === 'sport');
  const free = state.freeRuns.filter((r) => r.date === t);
  if (done.length) {
    const s = done[0], e = state.log[s.id];
    const km = e.actualKm ?? s.km, min = e.durationSec ? e.durationSec / 60 : s.min;
    const fr = (n) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
    return `<section class="today">
      <p class="eyebrow">Aujourd'hui · ${esc(dateShort(t))}</p>
      <h1 class="mega">Séance faite ✓</h1>
      <p class="today-detail">${esc(s.title)}</p>
      <div class="today-stats"><div><b>${fr(km)}</b><span>km</span></div><div><b>${Math.round(min)}</b><span>min</span></div>${e.avgHr ? `<div><b>${e.avgHr}</b><span>bpm moy.</span></div>` : ''}</div>
      ${coachLine(s, e) ? `<a class="coach-quote" href="#/recap/${s.id}"><span class="coach-head">Le mot du coach</span>${esc(frDates(coachLine(s, e)))}</a>` : ''}
      <a class="btn primary" href="#/recap/${s.id}">Voir le récap</a>
    </section>`;
  }
  if (free.length) {
    const r = free[0];
    return `<section class="today"><p class="eyebrow">Aujourd'hui · ${esc(dateShort(t))}</p>
      <h1 class="mega">Course libre ✓</h1>
      <div class="today-stats"><div><b>${Number(r.distanceKm).toLocaleString('fr-FR', { maximumFractionDigits: 1 })}</b><span>km</span></div></div></section>`;
  }
  return `<section class="today"><p class="eyebrow">Aujourd'hui · ${esc(dateShort(t))}</p>
    <h1 class="mega">Repos</h1>
    <p class="muted">${sport ? `${sportIcon(sport.sport)} ${esc(sport.title)}` : 'Pas de course prévue : la récupération fait partie de l\'entraînement.'}</p>
  </section>`;
}

/** Prochaine séance, en version compacte, sous l'état du jour. */
export function nextCard(s, t, canMove, bonusOk) {
  const w = weekOf(s.date);
  const E = w?.paces?.E;
  return `<section class="card next-card">
    <p class="eyebrow">Prochaine séance · ${esc(dateShort(s.date))}</p>
    <a class="next-link" href="#/session/${s.id}"><span class="icon">${iconOf(s)}</span><span><strong>${esc(s.title)}</strong>
      <small class="muted">${Number(s.km).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km · ${Math.round(s.min)} min${['easy', 'long'].includes(s.type) && E ? ` · ${pace(E[0])}–${pace(E[1])}/km` : ''}</small></span></a>
    ${canMove ? `<button class="btn ghost move-today" data-move="${s.id}">Faire cette séance aujourd'hui</button>` : ''}
    ${bonusOk ? '<button class="btn ghost move-today" id="add-bonus">+ Courir en plus aujourd\'hui</button>' : ''}
  </section>`;
}

export function todayHero(s, t, canMove, bonusOk) {
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
    ${bonusOk ? '<button class="btn ghost move-today" id="add-bonus">+ Courir en plus aujourd\'hui</button>' : ''}
  </section>`;
}

export function renderToday() {
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
  const painStop = painAdvice(p, state.log, t, state.painResolvedAt)?.level === 'stop';
  const ranToday = alreadyRan(t);
  const canMove = next && !ranToday && canMoveToToday(next, state.log, t) && !painStop;
  const bonusOk = next && !ranToday && next.date !== t && !painStop && !onPause(t) && canAddBonus(p, state.log, t);
  view.innerHTML = `
    ${pauseBlock(t)}
    ${painBlock(t)}
    ${next ? (next.date === t ? todayHero(next, t, canMove, bonusOk) : todayState(t) + nextCard(next, t, canMove, bonusOk)) : finished}
    ${!ranToday && !painStop && !onPause(t) && movableToToday(p, state.log, t).length
      ? '<button class="btn ghost move-today" id="advance">Faire une autre séance aujourd\'hui</button>' : ''}
    ${proposalsCard(t)}
    ${celebrationCard(t)}
    ${sleepBlock(t)}
    ${strengthToday(t)}
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
  view.querySelector('#add-bonus')?.addEventListener('click', addBonusToday);
  view.querySelector('#advance')?.addEventListener('click', advanceSheet);
  view.querySelectorAll('[data-feel]').forEach((b) => b.addEventListener('click', () => {
    const [id, feel] = b.dataset.feel.split(':');
    state.log[id] = { ...state.log[id], feel };
    persist();
    renderToday();
    analyzePending();
  }));
  bindCoachBlocks(t, next, makeup);
  bindCareBlocks(t);
  bindCelebration(view, renderToday);
  bindProposals(view, renderToday);
  view.querySelector('#push-week')?.addEventListener('click', () => pushWeek({ retry: true }));
  view.querySelector('#sync-now')?.addEventListener('click', () => syncActivities(true));
  syncActivities(false).then(async () => {
    if (await fetchProposals() && (location.hash === '' || location.hash === '#/')) renderToday();
    weeklyCoach();
    detectTestResults();
    await analyzePending();
    await refreshReadiness();
    return pushWeek({ silent: true });
  });
}


export function coachBlock(t) {
  const notes = state.coachNotes.filter((n) => n.date >= addDays(t, -7)).map((n) => ({ s: findSession(n.id), a: state.log[n.id]?.analysis })).filter((x) => x.s && x.a);
  if (!notes.length) return '';
  return `<section class="card"><h2>Analyse de tes séances</h2>${notes.map(({ s, a }) => {
    const v = VERDICT[a.verdict] ?? VERDICT.unknown;
    return `<a class="coach-row" href="#/recap/${s.id}"><span class="verdict ${v.cls}">${v.icon} ${v.label}</span>
      <span><strong>${esc(s.title)}</strong> <span class="muted">· ${esc(dateShort(s.date))}</span><small>${esc(frDates(a.note ?? a.details[0] ?? ''))}</small></span></a>`;
  }).join('')}</section>`;
}

export const currentLoad = () => loadStatus([...Object.values(state.acts), ...manualActivities(state.plan, state.log)], today(), state.hr);

export function loadBlock(t) {
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

export async function refreshReadiness() {
  const t = today();
  // On récupère la forme du jour même les jours de repos : c'est aussi le canal du score de sommeil.
  if (!garminOn()) return;
  const rd = state.readiness;
  // On réessaie tant que le sommeil n'est pas arrivé (Garmin le calcule souvent après la forme/VFC),
  // au plus toutes les 10 min. Avant, l'app s'arrêtait dès qu'elle avait la forme → le sommeil restait bloqué.
  if (!readinessNeedsRefresh(rd, t)) return;
  try {
    const r = await api(state.garmin, 'GET', `/readiness?day=${t}`);
    state.readiness = { date: t, data: r, at: Date.now(), handled: rd?.date === t ? rd.handled : false };
    persist();
    if (location.hash === '' || location.hash === '#/') renderToday();
  } catch { /* non bloquant */ }
}

/** Sommeil et forme du jour, toujours affichés (pour vérifier que Garmin a bien tout envoyé). */
export function sleepBlock(t) {
  if (!garminOn()) return '';
  const rd = state.readiness;
  if (rd?.date !== t) return '<section class="card sleep-card"><p class="muted small">😴 Vérification du sommeil et de la forme du jour…</p></section>';
  const r = rd.data || {};
  if (r.sleepScore != null || r.hrvStatus || r.score != null) {
    const bits = [
      r.sleepScore != null ? `😴 <strong>Sommeil ${r.sleepScore}/100</strong>` : '😴 Sommeil : pas encore reçu',
      r.hrvStatus ? `VFC ${HRV_FR[r.hrvStatus] ?? r.hrvStatus.toLowerCase()}` : null,
      r.score != null ? `disponibilité ${r.score}/100` : null,
      r.recoveryHours ? `récup. ${r.recoveryHours} h` : null,
    ].filter(Boolean);
    return `<section class="card sleep-card"><p class="muted small">${bits.join(' · ')} · pris en compte dans ta forme du jour</p></section>`;
  }
  return `<section class="card sleep-card"><p class="muted small">😴 Sommeil pas encore reçu de Garmin. Porte ta montre la nuit, puis ouvre Garmin Connect pour synchroniser (ça peut prendre quelques heures après le réveil).</p></section>`;
}

export function readinessBlock(t, next) {
  const rd = state.readiness;
  if (!rd || rd.date !== t || !next || next.date !== t) return '';
  const r = rd.data;
  const advice = readinessAdvice(r, next);
  if (!advice) return '';
  const bits = [r.score != null ? `disponibilité ${r.score}/100 (${LEVEL_FR[r.level] ?? '—'})` : null,
    r.hrvStatus ? `VFC ${HRV_FR[r.hrvStatus] ?? r.hrvStatus.toLowerCase()}` : null,
    r.recoveryHours ? `récupération restante ${r.recoveryHours} h` : null].filter(Boolean);
  const actions = rd.handled ? '' : advice.action === 'swap' || advice.action === 'suggest'
    ? `<div class="actions"><button class="btn ghost" id="rd-keep">Garder</button><button class="btn primary" id="rd-ease">Alléger</button></div>`
    : advice.action === 'shorten' ? `<div class="actions"><button class="btn ghost" id="rd-keep">Garder</button><button class="btn primary" id="rd-short">Raccourcir</button></div>` : '';
  return `<section class="card ${advice.action === 'swap' ? 'warn' : ''}"><h2>Forme du jour</h2>
    <p class="muted">${esc(bits.join(' · '))}</p><p>${esc(advice.text)}</p>${actions}</section>`;
}

export function makeupBlock(t, m) {
  if (!m) return '';
  const target = findSafeDay(state.plan, state.log, m.id, addDays(t, -1));
  return `<section class="card warn"><h2>Séance clé manquée</h2>
    <p><strong>${esc(m.title)}</strong> (${esc(dateLong(m.date))}) n'a pas été faite.</p>
    ${target ? `<p class="muted">Je peux la replacer le <strong>${esc(dateLong(target.date))}</strong> à la place du footing, sans la coller à une autre séance dure ni au lendemain d'un futsal.</p>
      <div class="actions"><button class="btn ghost" data-mk-drop="${m.id}">La laisser tomber</button><button class="btn primary" data-mk-do="${m.id}:${target.id}">La replacer</button></div>`
      : `<p class="muted">Pas de jour sûr d'ici la fin de la semaine : mieux vaut la laisser tomber que surcharger. On reprend le plan normalement.</p>
      <button class="btn" data-mk-drop="${m.id}">OK</button>`}</section>`;
}

export function bindCoachBlocks(t, next) {
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


/** Séances importées de Garmin sans ressenti : on le demande (c'est ce qui sert à adapter le plan). */
export function feelPrompt(t) {
  const todo = allSessions().filter((s) => state.log[s.id]?.source === 'garmin' && !state.log[s.id].feel && s.date >= addDays(t, -7));
  if (!todo.length) return '';
  return `<section class="card"><h2>Comment c'était ?</h2>${todo.map((s) => {
    const e = state.log[s.id];
    return `<div class="feel-row"><p><strong>${esc(s.title)}</strong> <span class="muted">· ${esc(dateShort(s.date))} · ${e.actualKm} km${e.paceSecPerKm ? ` à ${pace(e.paceSecPerKm)}/km` : ''}${e.avgHr ? ` · ${e.avgHr} bpm` : ''}</span></p>
      <div class="choices">${[['easy', 'Facile'], ['ok', 'Correct'], ['hard', 'Dur']].map(([f, l]) => `<button class="btn small-btn" data-feel="${s.id}:${f}">${l}</button>`).join('')}</div></div>`;
  }).join('')}</section>`;
}

export function garminTodayBlock(t) {
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

/** Ajoute un footing facile aujourd'hui, en plus du plan (aucune séance déplacée). */
export function addBonusToday() {
  const t = today();
  const sugg = suggestedBonusKm(state.plan, t);
  showSheet(`<h2>Courir en plus aujourd'hui</h2>
    <p class="muted">Un footing facile en plus, sans toucher au reste du plan.</p>
    <label class="field">Distance (km)<input type="number" id="bonus-km" min="1" max="20" step="0.5" value="${sugg}"></label>
    <label class="check"><input type="checkbox" id="bonus-strides"> Avec lignes droites (quelques accélérations courtes en fin de footing)</label>
    <button class="btn primary" id="bonus-go">Ajouter le footing</button>
    <button class="btn ghost" data-close>Annuler</button>`, (sheet) => {
    sheet.querySelector('#bonus-go').addEventListener('click', () => {
      const km = Number(sheet.querySelector('#bonus-km').value) || sugg;
      const strides = sheet.querySelector('#bonus-strides').checked;
      const { plan, id } = addBonus(state.plan, t, { km, strides });
      state.plan = plan;
      delete state.log[id]; // bonus neuf : on efface un éventuel ancien statut (fait / sauté) du même jour
      persist();
      closeSheet();
      pushWeek({ silent: true });
      location.hash = `#/session/${id}`;
    });
  });
}

/** Avance une séance à aujourd'hui, en vérifiant les règles de sécurité. */
export function moveToToday(id) {
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

/** Sélecteur : amener à aujourd'hui la course ou le renfo de son choix (en forme, ou fatigué et on veut plus doux). */
function advanceSheet() {
  const t = today();
  const list = movableToToday(state.plan, state.log, t);
  if (!list.length) { toast('Aucune séance à avancer.'); return; }
  const meta = (s) => (s.type === 'strength' ? `renforcement · ~${Math.round(s.min)} min`
    : `${Number(s.km).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km · ~${Math.round(s.min)} min`);
  showSheet(`<h2>Faire une séance aujourd'hui</h2>
    <p class="muted">Choisis la séance à amener à aujourd'hui. Celle d'aujourd'hui, si tu en as une, prendra sa place.</p>
    ${list.map((s) => `<button class="btn adv-opt" data-adv="${esc(s.id)}"><span class="icon">${iconOf(s)}</span>
      <span><strong>${esc(s.title)}</strong><small class="muted">${esc(dateShort(s.date))} · ${meta(s)}</small></span></button>`).join('')}
    <button class="btn ghost" data-close>Annuler</button>`, (sheet) => {
    sheet.querySelectorAll('[data-adv]').forEach((b) => b.addEventListener('click', () => {
      const s = findSession(b.dataset.adv);
      closeSheet();
      if (s.type === 'strength') advanceStrength(s.id); else moveToToday(s.id);
    }));
  });
}

/** Avance un renforcement à aujourd'hui sans toucher à la course du jour (les deux peuvent coexister). */
function advanceStrength(id) {
  const t = today();
  const s = findSession(id);
  const from = s.date;
  const copy = structuredClone(state.plan);
  const moved = copy.weeks.flatMap((w) => w.sessions).find((x) => x.id === id);
  moved.date = t;
  moved.movedFrom = moved.movedFrom ?? from;
  copy.weeks.forEach((w) => w.sessions.sort((a, b) => a.date.localeCompare(b.date)));
  state.plan = copy;
  persist();
  repushIfNeeded([id]);
  showSheet(`<h2>Renforcement avancé</h2><p>Ton renforcement est prévu aujourd'hui. Le ${esc(dateLong(from))} n'en a plus.</p>
    <button class="btn primary" data-close>OK</button>`);
  location.hash = `#/session/${id}`;
}

export function doAdapt(newRace = null) {
  const { plan, adjustment } = adaptPlan(state.plan, state.log, today(), newRace, state.hr, currentLoad());
  state.plan = plan;
  persist();
  refreshPushed();
  showSheet(`<h2>Plan réajusté</h2><ul>${adjustment.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    <button class="btn primary" data-close>OK</button>`);
  route();
}
