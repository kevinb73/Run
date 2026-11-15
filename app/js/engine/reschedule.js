// Déplacement d'une séance (ex. : « je fais la séance de lundi dès aujourd'hui »),
// avec vérification des règles de sécurité (pas deux séances dures collées).

import { addDays, weekday, daysBetween } from './dates.js';
import { easyRun, estimate } from './workouts.js';

export const HARD_TYPES = ['threshold', 'intervals', 'hills', 'fartlek', 'race-pace', 'test'];
const isHard = (s) => HARD_TYPES.includes(s.type);

function locate(plan, id) {
  for (const w of plan.weeks) {
    const s = w.sessions.find((x) => x.id === id);
    if (s) return { week: w, session: s };
  }
  return null;
}

/** Une séance peut être avancée si elle est à venir (7 jours max), non faite, et n'est ni une course ni un sport facultatif. */
export function canMoveToToday(s, log, today) {
  return s.date > today && s.date <= addDays(today, 7) && !s.optional && s.type !== 'race' && !log[s.id];
}

/**
 * Déplace la séance `id` au jour `toDate`.
 * Si une séance non faite est déjà prévue ce jour-là, les deux sont échangées.
 * @returns { plan, swappedWith, conflict } — conflict : séance dure qui se retrouve le lendemain d'une séance dure.
 */
export function moveSession(plan, id, toDate, log) {
  const copy = structuredClone(plan);
  const found = locate(copy, id);
  if (!found) throw new Error('Séance introuvable.');
  const { session } = found;
  const fromDate = session.date;
  const sports = copy.profile.otherSports ?? [];
  const altFor = (date) => sports.find((x) => x.day === weekday(date))?.kind;

  const all = copy.weeks.flatMap((w) => w.sessions);
  const occupant = all.find((x) => x.date === toDate && !x.optional && x.id !== id && !log[x.id]);
  let swappedWith = null;
  if (occupant) {
    occupant.date = fromDate;
    occupant.movedFrom ??= toDate;
    setAlt(occupant, altFor(fromDate));
    swappedWith = occupant.id;
  }
  session.movedFrom ??= fromDate;
  session.date = toDate;
  setAlt(session, altFor(toDate));
  for (const w of copy.weeks) w.sessions.sort((a, b) => a.date.localeCompare(b.date));

  // Règle de sécurité : pas de séance dure la veille ou le lendemain d'une autre séance dure.
  let conflict = null;
  if (isHard(session)) {
    const runs = copy.weeks.flatMap((w) => w.sessions).filter((x) => !x.optional && !log[x.id] && x.id !== id);
    const next = runs.find((x) => x.date === addDays(toDate, 1) && isHard(x));
    if (next) conflict = next.id;
  }
  // Séance dure le lendemain d'un futsal/arbitrage réellement fait : on prévient.
  const yesterday = addDays(toDate, -1);
  const afterSport = isHard(session) && copy.weeks.flatMap((w) => w.sessions)
    .some((x) => x.date === yesterday && (x.type === 'sport' || x.alt) && (log[x.id]?.replacedBy || (x.type === 'sport' && log[x.id]?.done)));
  return { plan: copy, swappedWith, conflict, afterSport };
}

/** Transforme une séance dure en footing de distance comparable (allures de sa semaine). */
export function downgradeToEasy(plan, id) {
  const copy = structuredClone(plan);
  const { week, session } = locate(copy, id);
  const km = Math.max(3, Math.round(session.km * 0.8 * 2) / 2);
  const easy = easyRun({ paces: week.paces }, km);
  const est = estimate(easy.steps, week.paces);
  Object.assign(session, easy, { km: est.km, min: est.min, downgraded: true });
  week.volumeKm = Math.round(week.sessions.reduce((a, x) => a + x.km, 0) * 10) / 10;
  return copy;
}

function setAlt(s, kind) {
  if (kind) s.alt = kind; else delete s.alt;
}

const sportDaysOf = (plan) => [...new Set((plan.profile.otherSports ?? []).map((x) => x.day))];

/**
 * Jour de remplacement sûr pour une séance clé : un footing non fait, dans les 4 jours suivant `fromDate`
 * et avant la fin de la semaine, ni un jour de sport possible ni son lendemain, sans séance dure la veille ou le lendemain.
 */
export function findSafeDay(plan, log, sessionId, fromDate) {
  const all = plan.weeks.flatMap((w) => w.sessions);
  const week = plan.weeks.find((w) => w.sessions.some((x) => x.id === sessionId));
  const weekEnd = week ? addDays(week.start, 6) : addDays(fromDate, 4);
  const limit = addDays(fromDate, 4) < weekEnd ? addDays(fromDate, 4) : weekEnd;
  const sportDays = sportDaysOf(plan);
  const hardOn = (d) => all.some((x) => x.date === d && x.id !== sessionId && HARD_TYPES.includes(x.type) && !log[x.id]);
  return all
    .filter((x) => x.type === 'easy' && !x.optional && !log[x.id] && x.date > fromDate && x.date <= limit)
    .filter((x) => !sportDays.includes(weekday(x.date)) && !sportDays.includes((weekday(x.date) + 6) % 7))
    .filter((x) => !hardOn(addDays(x.date, -1)) && !hardOn(addDays(x.date, 1)))
    .sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
}

/** Séance clé (dure ou sortie longue) manquée ces 3 derniers jours, sans retour. */
export function missedKeySession(plan, log, today) {
  return plan.weeks.flatMap((w) => w.sessions)
    .filter((s) => (HARD_TYPES.includes(s.type) || s.type === 'long') && !s.optional && !log[s.id]
      && s.date < today && s.date >= addDays(today, -3))
    .sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}

/** Remplace le footing `target` par la séance `id` (le footing est abandonné). */
export function makeUp(plan, log, id, targetId) {
  const target = plan.weeks.flatMap((w) => w.sessions).find((x) => x.id === targetId);
  const { plan: moved } = moveSession(plan, id, target.date, log);
  return { plan: moved, dropped: targetId };
}

/** Raccourcit un footing (forme basse). */
export function shortenEasy(plan, id, factor = 0.67) {
  const copy = structuredClone(plan);
  const week = copy.weeks.find((w) => w.sessions.some((x) => x.id === id));
  const s = week.sessions.find((x) => x.id === id);
  const easy = easyRun({ paces: week.paces }, Math.max(2, Math.round(s.km * factor * 2) / 2));
  const est = estimate(easy.steps, week.paces);
  Object.assign(s, easy, { km: est.km, min: est.min, shortened: true });
  week.volumeKm = Math.round(week.sessions.reduce((a, x) => a + x.km, 0) * 10) / 10;
  return copy;
}

/**
 * Séance bonus : un footing facile ajouté aujourd'hui SANS toucher au reste du plan.
 * Possible si aucune course n'est prévue aujourd'hui, pas de bonus déjà ajouté, et le plan n'est pas terminé.
 */
export function canAddBonus(plan, log, today) {
  const all = plan.weeks.flatMap((w) => w.sessions);
  const lastDay = addDays(plan.weeks.at(-1).start, 6);
  if (today > lastDay) return false;
  return !all.some((s) => s.date === today && !s.optional && s.type !== 'sport' && !log[s.id]?.skipped);
}

export function addBonus(plan, today) {
  const copy = structuredClone(plan);
  const week = copy.weeks.find((w) => today >= w.start && today < addDays(w.start, 7)) ?? copy.weeks[0];
  // Durée : le footing le plus court à venir, plafonné à ~25 min (minimum 2 km).
  const easies = copy.weeks.flatMap((w) => w.sessions).filter((s) => s.type === 'easy' && s.date >= today).slice(0, 3);
  const E = week.paces.E;
  const km25 = (25 * 60) / ((E[0] + E[1]) / 2); // ~25 min à allure footing
  const km = Math.max(2, Math.min(...easies.map((s) => s.km), km25));
  const s = easyRun({ paces: week.paces }, Number.isFinite(km) ? km : 3);
  const est = estimate(s.steps, week.paces);
  const bonus = {
    id: `bonus-${today}`, date: today, ...s,
    title: 'Footing bonus',
    description: 'Séance en plus du plan : reste très facile, elle ne remplace rien.',
    km: est.km, min: est.min, bonus: true,
  };
  week.sessions = [...week.sessions, bonus].sort((a, b) => a.date.localeCompare(b.date));
  return { plan: copy, id: bonus.id };
}

const DAY_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

/**
 * « Pas dispo ce jour-là » : jours de remplacement possibles dans la même semaine (à partir d'aujourd'hui),
 * du meilleur au moins bon. Un jour déjà occupé par une course n'est pas proposé (pas de double séance).
 * Séance dure / longue : jamais un jour de sport ni son lendemain, ni collée à une autre séance dure ou longue.
 * @returns [{ date, label, note }]
 */
export function unavailableOptions(plan, log, id, today) {
  const all = plan.weeks.flatMap((w) => w.sessions);
  const s = all.find((x) => x.id === id);
  const week = plan.weeks.find((w) => w.sessions.some((x) => x.id === id));
  if (!s || !week) return [];
  const sportDays = sportDaysOf(plan);
  const heavy = (x) => HARD_TYPES.includes(x.type) || x.type === 'long';
  const runOn = (d) => all.find((x) => x.date === d && x.id !== id && !x.optional && x.type !== 'strength' && !log[x.id]?.skipped);
  const out = [];
  for (let k = 0; k < 7; k++) {
    const d = addDays(week.start, k);
    if (d < today || d === s.date || runOn(d)) continue;
    const wd = weekday(d);
    const sportDay = sportDays.includes(wd), afterSport = sportDays.includes((wd + 6) % 7);
    const nextHeavy = [runOn(addDays(d, 1)), runOn(addDays(d, -1))].some((x) => x && heavy(x));
    if (heavy(s) && (sportDay || afterSport || nextHeavy)) continue;
    let score = 0, note = '';
    if (sportDay) { score += 3; note = 'jour de sport possible : footing seulement si tu n\'y vas pas'; }
    else if (afterSport) { score += 1; note = 'lendemain de sport : reste très facile'; }
    if (nextHeavy) { score += 2; note ||= 'à côté d\'une séance exigeante : reste très facile'; }
    if (heavy(s) && sportDays.includes((wd + 1) % 7)) { score += 2; note ||= 'veille d\'un futsal / match : garde des jambes'; }
    score += Math.abs(daysBetween(s.date, d)) * 0.1;
    out.push({ date: d, label: DAY_NAMES[wd], note, score });
  }
  return out.sort((a, b) => a.score - b.score).slice(0, 3).map(({ score, ...o }) => o);
}

/**
 * Séances que l'on peut avancer à aujourd'hui : courses à venir (≤ 8 j, non faites) et renforcements.
 * Sert au sélecteur « faire une autre séance aujourd'hui » (l'utilisateur se sent en forme, ou fatigué et veut une séance plus douce).
 */
export function movableToToday(plan, log, today) {
  return plan.weeks.flatMap((w) => w.sessions)
    .filter((s) => s.date > today && s.date <= addDays(today, 8)
      && !log[s.id]?.done && !log[s.id]?.skipped && s.type !== 'race'
      && (s.type === 'strength' || (!s.optional && s.type !== 'sport')))
    .sort((a, b) => a.date.localeCompare(b.date));
}
