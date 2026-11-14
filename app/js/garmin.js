// Client du serveur de synchronisation Garmin.

export class GarminError extends Error {}

export async function api(cfg, method, path, body) {
  if (!cfg?.url || !cfg?.key) throw new GarminError('Serveur Garmin non configuré.');
  let res;
  try {
    res = await fetch(cfg.url.replace(/\/$/, '') + path, {
      method,
      headers: { 'X-Api-Key': cfg.key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GarminError('Serveur injoignable : vérifie ta connexion internet ou l\'adresse du serveur.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* corps vide */ }
  if (!res.ok) throw new GarminError(data.detail || `Erreur serveur (${res.status}).`);
  return data;
}

/** Ce qui est envoyé au serveur pour une séance (pas de données inutiles). */
export function sessionPayload(s) {
  return { id: s.id, date: s.date, title: s.title, description: s.description, min: s.min, steps: s.steps };
}
