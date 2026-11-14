// Questionnaire d'entrée : une question par écran, comme un coach qui fait connaissance.

import { esc, DAYS_SHORT, dayName, duration, dateFull } from './format.js';
import { RACES } from './engine/plan.js';
import { addDays, todayISO } from './engine/dates.js';

const LEVELS = [
  { id: 'beginner', label: 'Débutant', hint: 'Je cours depuis moins d\'un an, ou de façon irrégulière.' },
  { id: 'intermediate', label: 'Intermédiaire', hint: 'Je cours régulièrement depuis plus d\'un an, j\'ai déjà fait quelques courses.' },
  { id: 'advanced', label: 'Confirmé', hint: 'Je m\'entraîne avec structure (fractionné, seuil), plusieurs années de pratique.' },
];

const REF_DISTANCES = [
  { m: 5000, label: '5 km' }, { m: 10000, label: '10 km' }, { m: 21097, label: 'Semi' }, { m: 42195, label: 'Marathon' },
];

function timeInputs(name, sec) {
  const h = sec ? Math.floor(sec / 3600) : '', m = sec ? Math.floor((sec % 3600) / 60) : '', s = sec ? sec % 60 : '';
  return `<div class="time-input">
    <label><input type="number" inputmode="numeric" min="0" max="9" name="${name}-h" value="${h}" placeholder="0"><span>h</span></label>
    <label><input type="number" inputmode="numeric" min="0" max="59" name="${name}-m" value="${m}" placeholder="00"><span>min</span></label>
    <label><input type="number" inputmode="numeric" min="0" max="59" name="${name}-s" value="${s}" placeholder="00"><span>s</span></label>
  </div>`;
}

function readTime(form, name) {
  const v = (k) => Number(form.querySelector(`[name="${name}-${k}"]`)?.value || 0);
  const t = v('h') * 3600 + v('m') * 60 + v('s');
  return t > 0 ? t : null;
}

export function defaultDraft() {
  return {
    raceDistance: null, raceDate: '', targetTimeSec: null, level: null,
    recent: null, hasRecent: null, weeklyKm: 15, longestRunKm: 8, days: [1, 3, 6], longRunDay: 6,
  };
}

/** Les étapes : render(draft) → HTML ; read(form, draft) → message d'erreur ou null. */
export const STEPS = [
  {
    title: 'Quelle course prépares-tu ?',
    render: (d) => `<div class="choices">${Object.entries(RACES).map(([m, r]) => `
      <label class="choice"><input type="radio" name="dist" value="${m}" ${d.raceDistance == m ? 'checked' : ''}><span>${r.label}</span></label>`).join('')}</div>`,
    read: (f, d) => {
      const v = f.querySelector('[name=dist]:checked');
      if (!v) return 'Choisis une distance.';
      d.raceDistance = Number(v.value);
    },
  },
  {
    title: 'Quand a lieu la course ?',
    render: (d) => `<input class="big-input" type="date" name="date" value="${esc(d.raceDate)}" min="${addDays(todayISO(), 21)}">
      <p class="hint">Minimum 3 semaines. Idéalement 10 à 20 semaines pour un 10 km, 16 à 20 pour un marathon. Au-delà, le plan commence par une phase de fondation.</p>`,
    read: (f, d) => {
      const v = f.querySelector('[name=date]').value;
      if (!v) return 'Indique la date de la course.';
      if (v < addDays(todayISO(), 21)) return 'La course doit être dans au moins 3 semaines.';
      d.raceDate = v;
    },
  },
  {
    title: 'Quel est ton niveau ?',
    render: (d) => `<div class="choices col">${LEVELS.map((l) => `
      <label class="choice wide"><input type="radio" name="level" value="${l.id}" ${d.level === l.id ? 'checked' : ''}>
      <span><strong>${l.label}</strong><small>${l.hint}</small></span></label>`).join('')}</div>`,
    read: (f, d) => {
      const v = f.querySelector('[name=level]:checked');
      if (!v) return 'Choisis ton niveau.';
      d.level = v.value;
    },
  },
  {
    title: 'Ton chrono de référence',
    render: (d) => `<p class="lead">Une course ou un test à fond de moins de 3 mois. C'est ce qui calibre toutes tes allures.</p>
      <div class="choices">${REF_DISTANCES.map((r) => `
        <label class="choice small"><input type="radio" name="refd" value="${r.m}" ${d.recent?.distanceM === r.m ? 'checked' : ''}><span>${r.label}</span></label>`).join('')}
      </div>
      ${timeInputs('ref', d.recent?.timeSec)}
      <label class="check"><input type="checkbox" name="noref" ${d.hasRecent === false ? 'checked' : ''}> Je n'ai pas de chrono récent</label>`,
    read: (f, d) => {
      if (f.querySelector('[name=noref]').checked) { d.recent = null; d.hasRecent = false; return; }
      const dist = f.querySelector('[name=refd]:checked');
      const t = readTime(f, 'ref');
      if (!dist || !t) return 'Indique la distance et le temps, ou coche « pas de chrono ».';
      const paceSec = t / (Number(dist.value) / 1000);
      if (paceSec < 150 || paceSec > 600) return 'Ce temps semble incohérent pour cette distance, vérifie la saisie.';
      d.recent = { distanceM: Number(dist.value), timeSec: t };
      d.hasRecent = true;
    },
  },
  {
    title: 'Ton objectif de temps',
    render: (d) => `<p class="lead">Optionnel. Laisse vide si l'objectif est de finir : le plan visera un chrono réaliste.</p>
      ${timeInputs('goal', d.targetTimeSec)}`,
    read: (f, d) => { d.targetTimeSec = readTime(f, 'goal'); },
  },
  {
    title: 'Ton volume actuel',
    render: (d) => `
      <label class="field">Kilomètres par semaine (moyenne du dernier mois)
        <div class="range"><input type="range" name="km" min="0" max="120" step="1" value="${d.weeklyKm}"><output>${d.weeklyKm} km</output></div></label>
      <label class="field">Plus longue sortie récente
        <div class="range"><input type="range" name="long" min="0" max="35" step="1" value="${d.longestRunKm}"><output>${d.longestRunKm} km</output></div></label>`,
    read: (f, d) => {
      d.weeklyKm = Number(f.querySelector('[name=km]').value);
      d.longestRunKm = Number(f.querySelector('[name=long]').value) || null;
    },
  },
  {
    title: 'Quels jours peux-tu courir ?',
    render: (d) => `<p class="lead">3 à 6 jours. Le nombre de jours = le nombre de séances par semaine.</p>
      <div class="days">${DAYS_SHORT.map((n, i) => `
        <label class="day"><input type="checkbox" name="day" value="${i}" ${d.days.includes(i) ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div>`,
    read: (f, d) => {
      const days = [...f.querySelectorAll('[name=day]:checked')].map((x) => Number(x.value));
      if (days.length < 3) return 'Choisis au moins 3 jours.';
      if (days.length > 6) return 'Garde au moins un jour de repos complet.';
      d.days = days;
      if (!days.includes(d.longRunDay)) d.longRunDay = days.includes(6) ? 6 : days.includes(5) ? 5 : days.at(-1);
    },
  },
  {
    title: 'Le jour de ta sortie longue ?',
    render: (d) => `<p class="lead">En général le week-end, quand tu as le plus de temps.</p>
      <div class="choices col">${d.days.map((i) => `
        <label class="choice wide"><input type="radio" name="lr" value="${i}" ${d.longRunDay === i ? 'checked' : ''}><span>${dayName(i)[0].toUpperCase() + dayName(i).slice(1)}</span></label>`).join('')}</div>`,
    read: (f, d) => { d.longRunDay = Number(f.querySelector('[name=lr]:checked')?.value ?? d.longRunDay); },
  },
  {
    title: 'Récapitulatif',
    render: (d) => `<dl class="recap">
      <dt>Course</dt><dd>${RACES[d.raceDistance].label}, le ${esc(dateFull(d.raceDate))}</dd>
      <dt>Objectif</dt><dd>${d.targetTimeSec ? duration(d.targetTimeSec) : 'Chrono réaliste calculé'}</dd>
      <dt>Niveau</dt><dd>${LEVELS.find((l) => l.id === d.level).label}</dd>
      <dt>Référence</dt><dd>${d.recent ? `${REF_DISTANCES.find((r) => r.m === d.recent.distanceM).label} en ${duration(d.recent.timeSec)}` : 'Aucune (niveau estimé)'}</dd>
      <dt>Volume</dt><dd>${d.weeklyKm} km/sem, sortie max ${d.longestRunKm ?? '—'} km</dd>
      <dt>Jours</dt><dd>${d.days.map((i) => DAYS_SHORT[i]).join(', ')} — longue le ${dayName(d.longRunDay)}</dd>
    </dl>`,
    read: () => null,
  },
];
