// Déplacement d'une séance (ex. : « je fais la séance de lundi dès aujourd'hui »),
// avec vérification des règles de sécurité (pas deux séances dures collées).

import { addDays, weekday } from './dates.js';
import { easyRun, estimate } from './workouts.js';

export const HARD_TYPES = ['threshold', 'intervals', 'hills', 'fartlek', 'race-pace'];
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
