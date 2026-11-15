// Recherche de boucle : construit la requête de parcours, lit la réponse, et exporte en GPX.
// Le calcul tourne côté app (iPhone) via OpenRouteService — clé API perso, gratuite.
//
// Le choix du terrain passe par le « profil » OpenRouteService :
//   routes/trottoirs → foot-walking ; chemins & nature → foot-hiking ; pistes cyclables → cycling-regular
// (la géométrie suit alors le réseau cyclable, même si on court).

export const TERRAINS = {
  route: { label: 'Routes et trottoirs', ors: 'foot-walking' },
  nature: { label: 'Chemins et nature', ors: 'foot-hiking' },
  cyclable: { label: 'Pistes cyclables', ors: 'cycling-regular' },
};

const ORS = 'https://api.openrouteservice.org';

/** Requête d'une boucle de ~km autour de `start` ({lat, lon}). `seed` change la boucle proposée. */
export function loopRequest(start, km, { seed = 1, terrain = 'route' } = {}) {
  const profile = TERRAINS[terrain]?.ors ?? 'foot-walking';
  return {
    url: `${ORS}/v2/directions/${profile}/geojson`,
    body: {
      coordinates: [[start.lon, start.lat]],
      options: { round_trip: { length: Math.round(km * 1000), points: 4, seed } },
      instructions: false,
      elevation: true,
    },
  };
}

/** Recherche d'adresse (point de départ) ; renvoie une URL GET (la clé est ajoutée par l'app). */
export function geocodeUrl(text, near) {
  const p = new URLSearchParams({ text, size: '6', 'boundary.country': 'FR' });
  if (near) { p.set('focus.point.lat', near.lat); p.set('focus.point.lon', near.lon); }
  return `${ORS}/geocode/search?${p}`;
}

/** Lit la réponse GeoJSON d'OpenRouteService → { coords: [[lat,lon]…], km, ascentM }. */
export function parseLoop(geojson) {
  const f = geojson?.features?.[0];
  if (!f?.geometry?.coordinates?.length) throw new Error('Aucun parcours trouvé ici. Essaie une autre distance ou un autre terrain.');
  const coords = f.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  const s = f.properties?.summary ?? {};
  return { coords, km: Math.round((s.distance ?? 0) / 100) / 10, ascentM: Math.round(s.ascent ?? 0) };
}

/** Parcours (liste de points) → fichier GPX importable dans Garmin Connect. */
export function toGpx(coords, name = 'Parcours Run Coach') {
  const esc = (x) => String(x).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const pts = coords.map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<gpx version="1.1" creator="Run Coach" xmlns="http://www.topografix.com/GPX/1/1">`
    + `<trk><name>${esc(name)}</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

/** Cadre géographique (pour centrer la carte) d'une liste de points. */
export function bounds(coords) {
  const lats = coords.map((c) => c[0]), lons = coords.map((c) => c[1]);
  return [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]];
}

/** Distance à vol d'oiseau entre deux points (mètres). */
export function distanceM(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

/** Ouvre l'itinéraire voiture vers un point dans l'app Plans de l'iPhone. */
export const drivingUrl = (pt, label = 'Départ de la boucle') =>
  `https://maps.apple.com/?daddr=${pt.lat},${pt.lon}&q=${encodeURIComponent(label)}&dirflg=d`;

const NATURE = [
  { type: 'cyclable', label: 'Piste cyclable', priority: 4, match: (tg) => tg.highway === 'cycleway' || tg.route === 'bicycle' },
  { type: 'voie_verte', label: 'Voie verte / chemin', priority: 3, match: (tg) => tg.highway === 'path' || tg.highway === 'footway' && tg.surface && tg.surface !== 'paved' },
  { type: 'foret', label: 'Forêt', priority: 3, match: (tg) => tg.natural === 'wood' || tg.landuse === 'forest' },
  { type: 'parc', label: 'Parc', priority: 2, match: (tg) => tg.leisure === 'park' || tg.leisure === 'nature_reserve' },
];

/** Requête Overpass : espaces verts et pistes autour d'un point (rayon en mètres). */
export function overpassQuery(center, radiusM = 8000) {
  const a = `(around:${Math.round(radiusM)},${center.lat},${center.lon})`;
  return `[out:json][timeout:25];(`
    + `way["highway"="cycleway"]${a};relation["route"="bicycle"]${a};`
    + `way["leisure"="park"]${a};way["leisure"="nature_reserve"]${a};`
    + `way["landuse"="forest"]${a};way["natural"="wood"]${a};`
    + `way["highway"="path"]["surface"!~"paved|asphalt"]${a};`
    + `);out center tags 120;`;
}

/** Réponse Overpass → coins nature nommés, classés (type prioritaire + proximité). */
export function parseNature(json, origin, max = 8) {
  const seen = new Set();
  const out = [];
  for (const el of json?.elements ?? []) {
    const tg = el.tags ?? {};
    const name = tg.name;
    if (!name || seen.has(name)) continue;
    const kind = NATURE.find((k) => k.match(tg));
    if (!kind) continue;
    const pt = el.center ? { lat: el.center.lat, lon: el.center.lon } : (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    if (!pt) continue;
    seen.add(name);
    out.push({ name, type: kind.type, label: kind.label, priority: kind.priority, lat: pt.lat, lon: pt.lon, distanceM: distanceM(origin, pt) });
  }
  return out.sort((a, b) => (b.priority - a.priority) || (a.distanceM - b.distanceM)).slice(0, max);
}
