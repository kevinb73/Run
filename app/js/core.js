import * as store from './store.js';
import { SPORTS } from './engine/plan.js';
import { api } from './garmin.js';
import { ICONS } from './icons.js';
import { todayISO, addDays } from './engine/dates.js';
import { esc, dateLong, dateShort, hm } from './format.js';
import { route } from './app.js';

export let state = normalize(store.load());
export function setState(s) { state = s; }

/** Champs ajoutés au fil des versions (Garmin) : valeurs par défaut. */
export function normalize(st) {
  return { garmin: null, pushed: {}, known: {}, freeRuns: [], acts: {}, coachNotes: [], lastSync: 0, ...st };
}

/** Nouveau plan : on garde la connexion Garmin, on retire de la montre les séances de l'ancien plan. */
export function resetPlan(plan) {
  const old = state;
  // On garde ce qui ne dépend pas du plan : profil cardiaque, activités (charge), dernière synchro des activités connues.
  setState(normalize({ garmin: old.garmin, plan, log: {}, hr: old.hr, acts: old.acts, known: old.known }));
  if (old.garmin?.connected) {
    const ids = Object.entries(old.pushed ?? {}).filter(([, info]) => info.date >= today()).map(([id]) => id);
    // Les nouvelles séances portent souvent les mêmes identifiants : on attend la fin du nettoyage
    // avant tout nouvel envoi, sinon une suppression tardive effacerait la séance tout juste envoyée.
    cleanup = (async () => {
      for (const id of ids) await api(old.garmin, 'DELETE', `/workouts/${encodeURIComponent(id)}`).catch(() => {});
    })();
  }
}
export let cleanup = Promise.resolve();
export const view = document.getElementById('view');
export const tabbar = document.getElementById('tabbar');
tabbar.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = ICONS[el.dataset.icon]; });
export const today = () => todayISO();

export function persist() {
  if (!store.save(state)) toast('Impossible d\'enregistrer (stockage plein ou mode privé).');
  scheduleBackup();
}


export let backupTimer = null;
/** Sauvegarde automatique (quelques secondes après la dernière modification) si un serveur est configuré. */
export function scheduleBackup() {
  if (!state.garmin?.url || !state.plan) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    const { garmin, ...rest } = state; // la clé du serveur ne part jamais dans la sauvegarde
    try {
      await api(state.garmin, 'PUT', '/backup', { app: 'run-coach', savedAt: new Date().toISOString(), ...rest, garminUrl: garmin?.url });
      state.lastBackup = Date.now();
      store.save(state);
    } catch { /* hors ligne : on réessaiera à la prochaine modification */ }
  }, 4000);
}

export async function restoreFromServer(cfg) {
  const { data } = await api(cfg, 'GET', '/backup');
  if (!data?.plan) throw new Error('Sauvegarde vide.');
  const { app: _app, savedAt: _s, garminUrl: _u, ...rest } = data;
  let connected = false, name;
  try { ({ connected, name } = await api(cfg, 'GET', '/garmin/status')); } catch { /* serveur OK mais statut indisponible */ }
  setState(normalize({ ...rest, garmin: { ...cfg, connected, name }, lastBackup: Date.parse(data.savedAt) || Date.now() }));
  store.save(state);
  return data.savedAt;
}

export function restoreSheet() {
  showSheet(`<h2>Restaurer depuis mon serveur</h2>
    <p class="muted">Récupère ton plan et ton historique sauvegardés automatiquement.</p>
    <form id="rs"><label class="field">Adresse du serveur<input type="url" name="url" value="${esc(state.garmin?.url ?? '')}" placeholder="https://…" required></label>
    <label class="field">Clé d'accès<input type="password" name="key" value="${esc(state.garmin?.key ?? '')}" required autocomplete="off"></label>
    <p class="error"></p><button class="btn primary" type="submit">Restaurer</button></form>`, (sheet) => {
    sheet.querySelector('#rs').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.currentTarget;
      try {
        const when = await restoreFromServer({ url: f.url.value.trim().replace(/\/$/, ''), key: f.key.value.trim() });
        closeSheet();
        toast(`Plan restauré (sauvegarde du ${new Date(when).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}).`);
        location.hash = '#/';
        route();
      } catch (ex) { f.querySelector('.error').textContent = ex.message; }
    });
  });
}

export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

export const allSessions = () => state.plan.weeks.flatMap((w) => w.sessions);
export const findSession = (id) => allSessions().find((s) => s.id === id);


/** Remplace les dates ISO d'un texte par « sam. 31 oct. ». */
export const frDates = (txt) => String(txt).replace(/\d{4}-\d{2}-\d{2}/g, (d) => dateShort(d));

export const sportIcon = (k) => ICONS[k === 'referee' ? 'referee' : 'futsal'];
export const isRunType = (s) => s.type !== 'sport' && s.type !== 'strength';
export const iconOf = (s) => (s.type === 'sport' ? sportIcon(s.sport) : ICONS[s.type]) ?? '•';


export function sessionCard(s, { big = false } = {}) {
  const entry = state.log[s.id];
  const status = entry?.replacedBy ? `<span class="badge done">${sportIcon(entry.replacedBy)}</span>` : entry?.done ? '<span class="badge done">Fait</span>' : entry?.skipped ? `<span class="badge skip">${s.optional ? 'Pas fait' : 'Sautée'}</span>` : '';
  return `<a class="card session-card type-${s.type} ${big ? 'big' : ''}" href="#/session/${s.id}">
    <span class="icon" aria-hidden="true">${iconOf(s)}</span>
    <span class="body">
      <span class="date">${esc(big ? dateLong(s.date) : dateShort(s.date))}</span>
      <span class="title">${esc(s.title)}</span>
      <span class="meta">${s.type === 'strength' ? `~${s.min} min · sans matériel` : s.optional ? 'Facultatif' : `${s.km} km · ~${hm(s.min)}`}${s.alt ? ` · ou ${sportIcon(s.alt)} ${SPORTS[s.alt].label.toLowerCase()}` : ''}</span>
    </span>${status}</a>`;
}

export const VERDICT = {
  success: { label: 'Réussie', icon: '✓', cls: 'ok' },
  hard: { label: 'Trop dure', icon: '↓', cls: 'bad' },
  easy: { label: 'Trop facile', icon: '↑', cls: 'up' },
  fast: { label: 'Trop rapide', icon: '⚠', cls: 'bad' },
  unknown: { label: 'Sans analyse', icon: '·', cls: '' },
};

export function analysisCard(a) {
  if (!a) return '';
  const v = VERDICT[a.verdict] ?? VERDICT.unknown;
  return `<section class="card"><div class="row between"><h2>Analyse</h2><span class="verdict ${v.cls}">${v.icon} ${v.label}</span></div>
    <ul class="adj">${a.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>${a.note ? `<p class="muted">${esc(a.note)}</p>` : ''}</section>`;
}

export function weekOf(date) {
  return state.plan.weeks.find((w) => w.start <= date && date < addDays(w.start, 7));
}

export const garminOn = () => !!state.garmin?.connected;

export const DAY_LONG = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
export const DAY_SHORT = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
export const fmtDays = (ds) => [...ds].sort((a, b) => a - b).map((d) => DAY_SHORT[d].toLowerCase()).join(', ');
export function sportsSummary(sports) {
  return Object.keys(SPORTS).map((k) => [k, sports.filter((x) => x.kind === k).map((x) => x.day)])
    .filter(([, ds]) => ds.length).map(([k, ds]) => `${SPORTS[k].label.toLowerCase()} ${fmtDays(ds)}`).join(' · ');
}

export const onPause = (t) => state.pause && t < state.pause.until;

export function showSheet(html, onMount) {
  closeSheet();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.hasAttribute('data-close')) closeSheet(); });
  document.body.append(wrap);
  onMount?.(wrap);
}

export function closeSheet() {
  document.querySelector('.sheet-backdrop')?.remove();
}
