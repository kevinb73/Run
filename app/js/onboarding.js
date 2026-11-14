// Questionnaire d'entrée : une question par écran, comme un coach qui fait connaissance.

import { esc, DAYS_SHORT, dayName, duration, dateFull } from './format.js';
import { RACES, FITNESS_GOALS, SPORTS } from './engine/plan.js';
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
    mode: null, fitnessGoal: null, durationWeeks: 12,
    raceDistance: null, raceDate: '', targetTimeSec: null, level: null,
    recent: null, hasRecent: null, weeklyKm: 15, longestRunKm: 8, days: [1, 3, 6], longRunDay: 6, otherSports: [],
  };
}

/** Les étapes : render(draft) → HTML ; read(form, draft) → message d'erreur ou null. */
const isRace = (d) => d.mode === 'race';
const isFitness = (d) => d.mode === 'fitness';
const isRestart = (d) => isFitness(d) && d.fitnessGoal === 'restart';
const minDays = (d) => (isFitness(d) && !isRestart(d) ? 2 : 3);

const FITNESS_HINTS = {
  restart: 'Je ne cours pas (ou plus). Alternance marche / course jusqu\'à 30 min sans m\'arrêter.',
  regular: 'Je cours de temps en temps, sans régularité. Je veux installer une routine.',
  progress: 'Je cours déjà régulièrement. Je veux devenir plus endurant et plus rapide.',
};

/** Étapes visibles pour les réponses en cours (certaines dépendent du mode choisi). */
export const visibleSteps = (d) => STEPS.filter((s) => !s.when || s.when(d));

export const STEPS = [
  {
    title: 'Quel est ton objectif ?',
    render: (d) => `<div class="choices col">
      <label class="choice wide"><input type="radio" name="mode" value="race" ${d.mode === 'race' ? 'checked' : ''}>
        <span><strong>Préparer une course</strong><small>5 km, 10 km, semi ou marathon, à une date précise.</small></span></label>
      <label class="choice wide"><input type="radio" name="mode" value="fitness" ${d.mode === 'fitness' ? 'checked' : ''}>
        <span><strong>Remise en forme</strong><small>Courir mieux et plus régulièrement, sans course en vue.</small></span></label></div>`,
    read: (f, d) => {
      const v = f.querySelector('[name=mode]:checked');
      if (!v) return 'Choisis un objectif.';
      d.mode = v.value;
    },
  },
  {
    when: isFitness,
    title: 'Où en es-tu ?',
    render: (d) => `<div class="choices col">${Object.entries(FITNESS_GOALS).map(([id, g]) => `
      <label class="choice wide"><input type="radio" name="fg" value="${id}" ${d.fitnessGoal === id ? 'checked' : ''}>
      <span><strong>${g.label}</strong><small>${FITNESS_HINTS[id]}</small></span></label>`).join('')}</div>`,
    read: (f, d) => {
      const v = f.querySelector('[name=fg]:checked');
      if (!v) return 'Choisis ce qui te correspond le mieux.';
      d.fitnessGoal = v.value;
      if (d.fitnessGoal === 'restart' && d.durationWeeks < 12) d.durationWeeks = 12;
    },
  },
  {
    when: isFitness,
    title: 'Sur combien de temps ?',
    render: (d) => `<p class="lead">Un cycle se termine par un bilan, puis l'app te propose le cycle suivant.</p>
      <div class="choices">${(isRestart(d) ? [12, 16] : [8, 12, 16]).map((n) => `
      <label class="choice"><input type="radio" name="dur" value="${n}" ${d.durationWeeks === n ? 'checked' : ''}><span>${n} semaines</span></label>`).join('')}</div>
      ${isRestart(d) ? '<p class="hint">12 semaines minimum pour une reprise : en dessous, la progression serait trop brutale pour les tendons.</p>' : ''}`,
    read: (f, d) => {
      const v = f.querySelector('[name=dur]:checked');
      if (!v) return 'Choisis une durée.';
      d.durationWeeks = Number(v.value);
    },
  },
  {
    when: isRace,
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
    when: isRace,
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
    when: (d) => !isRestart(d),
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
    when: (d) => !isRestart(d),
    title: 'Ton chrono de référence',
    render: (d) => `<p class="lead">Une course ou un test à fond de moins de 3 mois. C'est ce qui calibre toutes tes allures.${isFitness(d) ? ' Pas de chrono ? Aucun souci : le test de fin de cycle s\'en chargera.' : ''}</p>
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
    when: isRace,
    title: 'Ton objectif de temps',
    render: (d) => `<p class="lead">Optionnel. Laisse vide si l'objectif est de finir : le plan visera un chrono réaliste.</p>
      ${timeInputs('goal', d.targetTimeSec)}`,
    read: (f, d) => { d.targetTimeSec = readTime(f, 'goal'); },
  },
  {
    when: (d) => !isRestart(d),
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
    title: 'Pratiques-tu un autre sport ?',
    render: (d) => `<p class="lead">Coche les jours <strong>possibles</strong>, même si tu n'y vas pas chaque semaine. Le plan évitera de te mettre une séance dure le lendemain.</p>
      ${Object.entries(SPORTS).map(([kind, sp]) => `
        <p class="field">${sp.icon} ${sp.label}</p>
        <div class="days">${DAYS_SHORT.map((n, i) => `
          <label class="day"><input type="checkbox" name="sp-${kind}" value="${i}" ${d.otherSports.some((x) => x.kind === kind && x.day === i) ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div>`).join('')}
      <p class="hint">Aucun autre sport ? Laisse tout décoché et continue.</p>`,
    read: (f, d) => {
      d.otherSports = Object.keys(SPORTS).flatMap((kind) =>
        [...f.querySelectorAll(`[name=sp-${kind}]:checked`)].map((x) => ({ day: Number(x.value), kind })));
      const busy = new Set(d.otherSports.map((x) => x.day));
      d.days = d.days.filter((x) => !busy.has(x));
    },
  },
  {
    title: 'Quels jours peux-tu courir ?',
    render: (d) => {
      const busy = new Set(d.otherSports.map((x) => x.day));
      const min = minDays(d);
      return `<p class="lead">${isRestart(d) ? '3 séances par semaine suffisent en reprise : choisis au moins 3 jours, l\'app gardera les mieux espacés.' : `${min} à 6 jours. Le nombre de jours = le nombre de courses par semaine.`}${busy.size ? ' Les jours de sport sont grisés.' : ''}</p>
      <div class="days">${DAYS_SHORT.map((n, i) => `
        <label class="day ${busy.has(i) ? 'busy' : ''}"><input type="checkbox" name="day" value="${i}" ${d.days.includes(i) ? 'checked' : ''} ${busy.has(i) ? 'disabled' : ''}><span>${busy.has(i) ? SPORTS[d.otherSports.find((x) => x.day === i).kind].icon : n}</span></label>`).join('')}</div>
      ${isFitness(d) && !isRestart(d) && busy.size ? '<p class="hint">Avec ton autre sport, 2 courses par semaine suffisent pour progresser en endurance.</p>' : ''}`;
    },
    read: (f, d) => {
      const days = [...f.querySelectorAll('[name=day]:checked')].map((x) => Number(x.value));
      const min = minDays(d);
      if (days.length < min) return `Choisis au moins ${min} jours.`;
      if (days.length > 6) return 'Garde au moins un jour de repos complet.';
      d.days = days;
      if (!days.includes(d.longRunDay)) d.longRunDay = days.includes(6) ? 6 : days.includes(5) ? 5 : days.at(-1);
    },
  },
  {
    when: (d) => !isRestart(d),
    title: 'Le jour de ta sortie longue ?',
    render: (d) => `<p class="lead">En général le week-end, quand tu as le plus de temps.</p>
      <div class="choices col">${d.days.map((i) => `
        <label class="choice wide"><input type="radio" name="lr" value="${i}" ${d.longRunDay === i ? 'checked' : ''}><span>${dayName(i)[0].toUpperCase() + dayName(i).slice(1)}</span></label>`).join('')}</div>`,
    read: (f, d) => { d.longRunDay = Number(f.querySelector('[name=lr]:checked')?.value ?? d.longRunDay); },
  },
  {
    title: 'Récapitulatif',
    render: (d) => {
      const rows = isFitness(d)
        ? [['Objectif', FITNESS_GOALS[d.fitnessGoal].label], ['Durée', `${d.durationWeeks} semaines`]]
        : [['Course', `${RACES[d.raceDistance].label}, le ${esc(dateFull(d.raceDate))}`],
          ['Objectif', d.targetTimeSec ? duration(d.targetTimeSec) : 'Chrono réaliste calculé']];
      if (!isRestart(d)) {
        rows.push(['Niveau', LEVELS.find((l) => l.id === d.level).label]);
        rows.push(['Référence', d.recent ? `${REF_DISTANCES.find((r) => r.m === d.recent.distanceM).label} en ${duration(d.recent.timeSec)}` : 'Aucune (niveau estimé)']);
        rows.push(['Volume', `${d.weeklyKm} km/sem, sortie max ${d.longestRunKm ?? '—'} km`]);
        rows.push(['Jours', `${d.days.map((i) => DAYS_SHORT[i]).join(', ')} — longue le ${dayName(d.longRunDay)}`]);
      } else {
        rows.push(['Jours', d.days.map((i) => DAYS_SHORT[i]).join(', ')]);
      }
      if (d.otherSports.length) {
        rows.push(['Autres sports', Object.entries(SPORTS).map(([k, sp]) => {
          const ds = d.otherSports.filter((x) => x.kind === k).map((x) => DAYS_SHORT[x.day]);
          return ds.length ? `${sp.label} : ${ds.join(', ')}` : null;
        }).filter(Boolean).join(' · ')]);
      }
      return `<dl class="recap">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
    },
    read: () => null,
  },
];
