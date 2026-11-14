import { generatePlan, FITNESS_GOALS } from '../engine/plan.js';
import { visibleSteps, defaultDraft } from '../onboarding.js';
import { esc } from '../format.js';
import { route } from '../app.js';
import { allSessions, persist, resetPlan, restoreSheet, showSheet, state, today, view } from '../core.js';

export let draft = state.plan ? { ...defaultDraft(), ...state.plan.profile } : defaultDraft();
export let stepIdx = 0;

export function renderOnboarding() {
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

/** Refaire le questionnaire en partant des réponses du plan actuel. */
export function restartOnboarding(p) {
  draft = { ...defaultDraft(), ...p.profile, mode: p.mode ?? 'race', hasRecent: !!p.profile.recent };
  if (draft.mode === 'fitness') { delete draft.raceDate; draft.raceDistance = null; }
  stepIdx = 0;
}

/** Ne garde que les réponses pertinentes pour le mode choisi. */
export function cleanProfile(d) {
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
export function newCycle() {
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
