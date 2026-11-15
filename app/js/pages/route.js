// Écran « Trouver une boucle » : carte + calcul d'itinéraire en boucle (OpenRouteService, côté app).
// Le calcul tourne sur l'iPhone avec la clé perso de l'utilisateur ; rien ne passe par le serveur.
import { loopRequest, geocodeUrl, parseLoop, toGpx, bounds, TERRAINS, overpassQuery, parseNature, drivingUrl, OVERPASS_ENDPOINTS } from '../engine/route.js';
import { esc } from '../format.js';
import { state, persist, view, toast, today, showSheet, closeSheet } from '../core.js';

const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js';

let map = null, startMarker = null, routeLayer = null;
let loops = [], picked = 0;

/** Charge Leaflet une seule fois (réseau requis : le calcul d'itinéraire l'est de toute façon). */
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = LEAFLET_CSS; document.head.append(l);
    }
    const s = document.createElement('script'); s.src = LEAFLET_JS;
    s.onload = resolve; s.onerror = () => reject(new Error('Carte indisponible (pas de réseau ?).'));
    document.head.append(s);
  });
}

const orsHeaders = () => ({ Authorization: state.orsKey, 'Content-Type': 'application/json' });

async function orsPost(start, km, opts) {
  const { url, body } = loopRequest(start, km, opts);
  const res = await fetch(url, { method: 'POST', headers: orsHeaders(), body: JSON.stringify(body) });
  if (res.status === 403 || res.status === 401) throw new Error('Clé OpenRouteService refusée. Vérifie-la dans Profil.');
  if (res.status === 429) throw new Error('Limite quotidienne atteinte (réessaie demain).');
  if (!res.ok) throw new Error(`Calcul impossible (${res.status}).`);
  return parseLoop(await res.json());
}

export function renderRoute(arg) {
  const km = Number(arg) || state.routeKm || 5;
  if (!state.orsKey) { renderKeySetup(km); return; }
  loops = []; picked = 0;
  view.innerHTML = `
    <a href="#/" class="back">‹ Aujourd'hui</a>
    <h1>Trouver une boucle</h1>
    <div id="map" class="route-map"></div>
    <section class="card">
      <div class="route-controls">
        <label class="field">Distance (km)<input type="number" id="r-km" min="1" max="42" step="0.5" value="${km}"></label>
        <label class="field">Terrain<select id="r-terrain">${Object.entries(TERRAINS).map(([k, v]) => `<option value="${k}" ${state.routeTerrain === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
      </div>
      <div class="actions wrap">
        <button class="btn" id="r-here">📍 Ma position</button>
        <button class="btn" id="r-search">Chercher une adresse</button>
      </div>
      <p class="muted small">Tu peux aussi toucher la carte pour poser le point de départ.</p>
      <label class="field">Coins nature jusqu'à<select id="r-radius">${[[8000, '10 min de voiture'], [16000, '20 min'], [26000, '30 min']].map(([m, l]) => `<option value="${m}" ${(state.routeRadius ?? 8000) === m ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <button class="btn" id="r-nature">🌳 Coins nature à proximité</button>
      <button class="btn primary" id="r-find" disabled>Trouver des boucles</button>
    </section>
    <div id="r-results"></div>
    <section class="card note"><p class="muted small">Calcul via OpenRouteService (ta clé perso). Le parcours s'exporte en fichier GPX à importer dans Garmin Connect → Entraînement → Parcours.</p></section>`;

  loadLeaflet().then(initMap).catch((e) => toast(e.message));
  view.querySelector('#r-here').addEventListener('click', useGeolocation);
  view.querySelector('#r-search').addEventListener('click', searchAddress);
  view.querySelector('#r-nature').addEventListener('click', findNature);
  view.querySelector('#r-find').addEventListener('click', findLoops);
  view.querySelector('#r-terrain').addEventListener('change', (e) => { state.routeTerrain = e.target.value; persist(); });
}

function initMap() {
  const start = state.routeStart || { lat: 45.5, lon: 6.05 };
  map = window.L.map('map').setView([start.lat, start.lon], 14);
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  map.on('click', (e) => setStart({ lat: e.latlng.lat, lon: e.latlng.lng }));
  if (state.routeStart) setStart(state.routeStart, false);
  else useGeolocation();
}

function setStart(pt, recenter = true) {
  state.routeStart = pt; persist();
  if (!map) return;
  if (startMarker) startMarker.setLatLng([pt.lat, pt.lon]);
  else startMarker = window.L.marker([pt.lat, pt.lon]).addTo(map);
  if (recenter) map.setView([pt.lat, pt.lon], 14);
  const btn = view.querySelector('#r-find'); if (btn) btn.disabled = false;
}

function useGeolocation() {
  if (!navigator.geolocation) { toast('Position non disponible sur cet appareil.'); return; }
  toast('Localisation…');
  navigator.geolocation.getCurrentPosition(
    (p) => setStart({ lat: p.coords.latitude, lon: p.coords.longitude }),
    () => toast('Position refusée. Touche la carte ou cherche une adresse.'),
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

async function searchAddress() {
  const text = prompt('Adresse ou lieu de départ :');
  if (!text) return;
  try {
    const res = await fetch(geocodeUrl(text, state.routeStart) + `&api_key=${encodeURIComponent(state.orsKey)}`);
    if (!res.ok) throw new Error('Recherche indisponible.');
    const f = (await res.json()).features?.[0];
    if (!f) { toast('Lieu introuvable.'); return; }
    const [lon, lat] = f.geometry.coordinates;
    setStart({ lat, lon });
    toast(f.properties?.label ?? 'Départ placé.');
  } catch (e) { toast(e.message); }
}

/** Interroge Overpass en essayant plusieurs serveurs, avec un délai max (le service public est parfois lent). */
async function overpassFetch(query) {
  let lastErr = new Error('Recherche nature indisponible, réessaie dans un instant.');
  for (const url of OVERPASS_ENDPOINTS) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 22000);
    try {
      const res = await fetch(url, { method: 'POST', body: query, signal: ctrl.signal });
      clearTimeout(to);
      if (res.ok) return res.json();
    } catch (e) { clearTimeout(to); lastErr = e.name === 'AbortError' ? new Error('Recherche trop longue (serveur chargé). Réessaie.') : lastErr; }
  }
  throw lastErr;
}

/** Cherche des coins nature (parcs, forêts, pistes cyclables) à ~10 min de voiture et propose d'y partir. */
async function findNature() {
  const center = state.routeStart;
  if (!center) { toast('Place d\'abord un point de départ (ta position ou une adresse).'); return; }
  const radius = Number(view.querySelector('#r-radius')?.value) || 8000;
  state.routeRadius = radius; persist();
  const btn = view.querySelector('#r-nature'); btn.disabled = true; btn.textContent = 'Recherche… (10-20 s)';
  try {
    const json = await overpassFetch(overpassQuery(center, radius));
    const spots = parseNature(json, center);
    if (!spots.length) throw new Error('Pas de coin nature nommé trouvé dans les environs.');
    showSheet(`<h2>Coins nature à proximité</h2>
      <p class="muted">À vol d'oiseau depuis ton point. Choisis-en un : la boucle se calculera là-bas.</p>
      ${spots.map((s) => `<button class="btn adv-opt" data-spot="${esc(JSON.stringify({ lat: s.lat, lon: s.lon }))}">
        <span><strong>${esc(s.name)}</strong><small class="muted">${esc(s.label)} · ${(s.distanceM / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km${s.distanceM > 1500 ? ' 🚗' : ''}</small></span></button>`).join('')}
      <button class="btn ghost" data-close>Annuler</button>`, (sheet) => {
      sheet.querySelectorAll('[data-spot]').forEach((b) => b.addEventListener('click', () => {
        setStart(JSON.parse(b.dataset.spot));
        closeSheet();
        toast('Départ posé sur le coin nature. Choisis « Pistes cyclables » et lance la recherche.');
      }));
    });
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = '🌳 Coins nature à proximité'; }
}

async function findLoops() {
  const km = Number(view.querySelector('#r-km').value) || 5;
  const terrain = view.querySelector('#r-terrain').value;
  state.routeKm = km; state.routeTerrain = terrain; persist();
  const btn = view.querySelector('#r-find'); btn.disabled = true; btn.textContent = 'Recherche…';
  loops = [];
  try {
    for (const seed of [1, 7, 13]) {
      try { loops.push(await orsPost(state.routeStart, km, { seed, terrain })); } catch (e) { if (loops.length === 0 && seed === 13) throw e; }
    }
    if (!loops.length) throw new Error('Aucune boucle trouvée. Essaie une autre distance ou un autre point.');
    picked = 0; drawLoop(); renderResults();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = 'Trouver des boucles'; }
}

function drawLoop() {
  if (!map || !loops[picked]) return;
  if (routeLayer) routeLayer.remove();
  routeLayer = window.L.polyline(loops[picked].coords, { color: '#d7ff1f', weight: 5 }).addTo(map);
  map.fitBounds(bounds(loops[picked].coords), { padding: [20, 20] });
}

function renderResults() {
  const el = view.querySelector('#r-results');
  el.innerHTML = `<section class="card"><h2>Boucles proposées</h2>
    <div class="loop-opts">${loops.map((l, i) => `<button class="btn loop-opt ${i === picked ? 'primary' : ''}" data-loop="${i}">${l.km.toLocaleString('fr-FR')} km · ${l.ascentM} m D+${l.offRoadPct != null ? ` · ${l.offRoadPct}% chemins` : ''}</button>`).join('')}</div>
    ${loops[picked] ? `<p class="muted small">Boucle choisie : <strong>${loops[picked].km.toLocaleString('fr-FR')} km</strong> · ${loops[picked].ascentM} m de dénivelé${loops[picked].offRoadPct != null ? ` · <strong>${loops[picked].offRoadPct}%</strong> sur chemins/pistes (le reste sur route)` : ' · composition inconnue'}.</p>` : ''}
    <button class="btn primary" id="r-gpx">Exporter le GPX</button>
    <button class="btn" id="r-drive">🚗 M'y emmener (itinéraire voiture)</button></section>`;
  el.querySelectorAll('[data-loop]').forEach((b) => b.addEventListener('click', () => { picked = Number(b.dataset.loop); drawLoop(); renderResults(); }));
  el.querySelector('#r-gpx').addEventListener('click', exportGpx);
  el.querySelector('#r-drive').addEventListener('click', () => { if (state.routeStart) window.open(drivingUrl(state.routeStart), '_blank'); });
}

function exportGpx() {
  const l = loops[picked]; if (!l) return;
  const blob = new Blob([toGpx(l.coords, `Boucle ${l.km} km`)], { type: 'application/gpx+xml' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `boucle-${l.km}km-${today()}.gpx` });
  a.click();
  URL.revokeObjectURL(a.href);
  toast('GPX exporté : importe-le dans Garmin Connect.');
}

function renderKeySetup(km) {
  view.innerHTML = `
    <a href="#/" class="back">‹ Aujourd'hui</a>
    <h1>Trouver une boucle</h1>
    <section class="card">
      <p>Pour calculer des parcours, l'app a besoin d'une clé <strong>OpenRouteService</strong> (gratuite, 2 min).</p>
      <ol class="gpt-steps">
        <li>Va sur <strong>openrouteservice.org</strong> → « Sign up », crée un compte.</li>
        <li>Dans ton tableau de bord, crée une clé (« Request a token » / plan gratuit).</li>
        <li>Copie la clé et colle-la ci-dessous.</li>
      </ol>
      <form id="k-form"><label class="field">Clé OpenRouteService<input type="text" id="k-ors" placeholder="eyJ…" autocomplete="off"></label>
      <p class="muted small">Elle reste sur ton téléphone. Elle n'est utilisée que pour calculer tes parcours.</p>
      <button class="btn primary" type="submit">Enregistrer</button></form>
    </section>`;
  view.querySelector('#k-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const k = view.querySelector('#k-ors').value.trim();
    if (!k) return;
    state.orsKey = k; state.routeKm = km; persist();
    renderRoute(km);
  });
}
