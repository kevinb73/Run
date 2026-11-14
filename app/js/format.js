import { parseDate } from './engine/dates.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function pace(secPerKm) {
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}`;
}

export function paceRange([fast, slow]) {
  return Math.abs(slow - fast) < 1 ? `${pace(fast)}/km` : `${pace(fast)}–${pace(slow)}/km`;
}

export function duration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}'${String(s).padStart(2, '0')}`;
  return s ? `${m}'${String(s).padStart(2, '0')}` : `${m} min`;
}

const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
export const DAYS_SHORT = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
export const dayName = (i) => DAYS[i];

export function dateLong(iso) {
  return parseDate(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function dateShort(iso) {
  return parseDate(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function dateFull(iso) {
  return parseDate(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export const ZONES = {
  E: { label: 'Endurance', color: 'var(--z-e)' },
  M: { label: 'Allure marathon', color: 'var(--z-m)' },
  T: { label: 'Seuil', color: 'var(--z-t)' },
  I: { label: 'VMA', color: 'var(--z-i)' },
  R: { label: 'Vitesse', color: 'var(--z-r)' },
  race: { label: 'Allure course', color: 'var(--z-race)' },
  walk: { label: 'Marche', color: 'var(--muted)' },
};

export const KIND_LABEL = { warmup: 'Échauffement', cooldown: 'Retour au calme', recovery: 'Récupération', run: 'Course' };

export const TYPE_ICON = {
  easy: '○', long: '◎', threshold: '▲', intervals: '◆', hills: '⛰', fartlek: '≈', 'race-pace': '◉', race: '★', test: '⏱',
};

export function stepDuration(dur) {
  if (dur.type === 'distance') return dur.m >= 1000 ? `${+(dur.m / 1000).toFixed(2)} km` : `${dur.m} m`;
  return duration(dur.s);
}

/** Durée approximative en minutes → « 45 min » ou « 1h05 ». */
export const hm = (min) => (min >= 60 ? `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}` : `${Math.round(min)} min`);
