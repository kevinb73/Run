import { PHASES } from '../engine/plan.js';
import { currentWeek } from '../engine/adapt.js';
import { esc, dateShort, dateFull } from '../format.js';
import { sessionCard, state, today, view } from '../core.js';

export function renderPlan(openIdx) {
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

export function volumeChart() {
  const weeks = state.plan.weeks;
  const max = Math.max(...weeks.map((w) => w.volumeKm));
  const cur = currentWeek(state.plan, today());
  return weeks.map((w) => `<a href="#/plan/${w.index}" class="bar phase-${w.phase} ${w === cur ? 'current' : ''}" style="height:${(w.volumeKm / max) * 100}%" title="S${w.index + 1} : ${w.volumeKm} km"></a>`).join('');
}
