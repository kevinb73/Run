// Persistance locale (sur l'iPhone, dans le stockage de l'app installée).
// Une sauvegarde JSON exportable sert de filet de sécurité.

const KEY = 'run-coach:v1';

const empty = () => ({ plan: null, log: {} });

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty(), ...JSON.parse(raw) } : empty();
  } catch {
    return empty();
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function exportJSON(state) {
  return JSON.stringify({ app: 'run-coach', exportedAt: new Date().toISOString(), ...state }, null, 2);
}

export function importJSON(text) {
  const data = JSON.parse(text);
  if (data.app !== 'run-coach' || !data.plan) throw new Error('Fichier de sauvegarde invalide.');
  return { plan: data.plan, log: data.log ?? {} };
}
