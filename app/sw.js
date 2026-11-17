// Cache "réseau d'abord" : l'app fonctionne hors ligne, et récupère les mises à jour dès qu'il y a du réseau.
const CACHE = 'run-coach-v54';
const ASSETS = [
  './', './index.html', './css/style.css', './manifest.webmanifest', './icons/icon.svg', './icons/apple-touch-icon.png',
  './js/app.js', './js/core.js', './js/sync.js', './js/care.js', './js/pages/onboarding.js', './js/pages/today.js', './js/pages/plan.js', './js/pages/session.js', './js/pages/recap.js', './js/pages/progress.js', './js/pages/profile.js', './js/store.js', './js/format.js', './js/onboarding.js',
  './js/engine/vdot.js', './js/engine/plan.js', './js/engine/workouts.js', './js/engine/dates.js', './js/engine/adapt.js', './js/engine/reschedule.js', './js/engine/garminsync.js', './js/garmin.js', './js/progress.js', './js/icons.js', './fonts/anton-400.woff2', './fonts/inter-400.woff2', './fonts/inter-600.woff2', './fonts/inter-800.woff2', './js/engine/recap.js', './js/engine/recap-format.js', './js/engine/pause.js', './js/engine/pain.js', './js/engine/coach.js', './js/engine/analysis.js', './js/engine/easyfeedback.js', './js/engine/strength.js', './js/engine/replan.js', './js/engine/upgrade.js', './js/engine/monthly.js', './js/engine/records.js', './js/achievements.js', './js/proposals.js', './js/push.js', './js/engine/load.js', './js/engine/readiness.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Rappels de séance envoyés par le serveur (web push).
self.addEventListener('push', (e) => {
  let d = { title: 'Run Coach', body: '' };
  try { d = { ...d, ...e.data.json() }; } catch { if (e.data) d.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: './icons/apple-touch-icon.png', badge: './icons/apple-touch-icon.png', tag: 'runcoach', data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ('focus' in c) return c.focus();
    return self.clients.openWindow(e.notification.data?.url || './');
  }));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    // cache: 'no-cache' force la vérification auprès du serveur : les mises à jour arrivent immédiatement.
    fetch(e.request.url, { cache: 'no-cache' })
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
