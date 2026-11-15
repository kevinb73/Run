// Rappels de séance (web push) : « la veille au soir » et « le jour même », heures réglables.
// Sur iPhone, ça ne marche qu'une fois l'app ajoutée à l'écran d'accueil, et ça peut être capricieux.
import { api } from './garmin.js';
import { state } from './core.js';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** Clé VAPID (base64url) → tableau d'octets attendu par le navigateur. */
function urlB64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export const loadPushPrefs = () => api(state.garmin, 'GET', '/push/prefs');

/** Enregistre l'abonnement du navigateur et l'envoie au serveur avec les heures choisies. */
export async function enablePush(prefs) {
  if (!pushSupported()) throw new Error('Notifications non disponibles sur cet appareil. Ajoute l\'app à l\'écran d\'accueil, puis réessaie.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Autorisation refusée. Tu peux la réactiver dans les réglages de ton iPhone (Notifications → Run Coach).');
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api(state.garmin, 'GET', '/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
  await api(state.garmin, 'PUT', '/push/prefs', { subscription: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ...prefs });
}

/** Met à jour seulement les heures / interrupteurs (sans re-demander l'autorisation). */
export const updatePushPrefs = (prefs) => api(state.garmin, 'PUT', '/push/prefs', { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ...prefs });

/** Coupe les rappels : on retire l'abonnement du navigateur et du serveur. */
export async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch { /* pas d'abonnement : rien à faire */ }
  await api(state.garmin, 'DELETE', '/push/prefs');
}
