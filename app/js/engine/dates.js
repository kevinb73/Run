// Dates manipulées en chaînes 'YYYY-MM-DD' (heure locale) pour éviter les pièges de fuseau.

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function formatISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return formatISO(d);
}

/** Jour de la semaine, 0 = lundi … 6 = dimanche. */
export function weekday(s) {
  return (parseDate(s).getDay() + 6) % 7;
}

export function mondayOf(s) {
  return addDays(s, -weekday(s));
}

export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

export function todayISO() {
  return formatISO(new Date());
}
