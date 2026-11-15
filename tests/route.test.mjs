import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopRequest, geocodeUrl, parseLoop, toGpx, bounds, TERRAINS } from '../app/js/engine/route.js';

const START = { lat: 45.5, lon: 6.05 }; // Montmélian ~

test('loopRequest : profil selon le terrain, distance en mètres, départ unique', () => {
  const r = loopRequest(START, 5, { seed: 3, terrain: 'cyclable' });
  assert.match(r.url, /cycling-regular\/geojson$/);
  assert.deepEqual(r.body.coordinates, [[6.05, 45.5]]);
  assert.equal(r.body.options.round_trip.length, 5000);
  assert.equal(r.body.options.round_trip.seed, 3);
  assert.match(loopRequest(START, 5, { terrain: 'nature' }).url, /foot-hiking/);
  assert.match(loopRequest(START, 5).url, /foot-walking/, 'défaut = marche');
  assert.equal(TERRAINS.cyclable.ors, 'cycling-regular');
});

test('geocodeUrl : recherche d\'adresse en France, biaisée vers le point proche', () => {
  const u = geocodeUrl('gare montmélian', START);
  assert.match(u, /geocode\/search\?/);
  assert.match(u, /text=gare\+montm/);
  assert.match(u, /focus\.point\.lat=45\.5/);
  assert.match(u, /boundary\.country=FR/);
});

test('parseLoop : GeoJSON → points [lat,lon], distance, dénivelé', () => {
  const g = { features: [{ geometry: { coordinates: [[6.05, 45.5, 300], [6.06, 45.51, 310]] }, properties: { summary: { distance: 5120, ascent: 42 } } }] };
  const p = parseLoop(g);
  assert.deepEqual(p.coords[0], [45.5, 6.05]);
  assert.equal(p.km, 5.1);
  assert.equal(p.ascentM, 42);
  assert.throws(() => parseLoop({ features: [] }), /Aucun parcours/);
});

test('toGpx : trace valide, caractères échappés', () => {
  const gpx = toGpx([[45.5, 6.05], [45.51, 6.06]], 'Boucle <test>');
  assert.match(gpx, /^<\?xml/);
  assert.match(gpx, /<trkpt lat="45.5" lon="6.05"\/>/);
  assert.match(gpx, /Boucle &lt;test&gt;/);
  assert.equal((gpx.match(/<trkpt/g) || []).length, 2);
});

test('bounds : cadre englobant', () => {
  assert.deepEqual(bounds([[45.5, 6.05], [45.52, 6.08], [45.48, 6.02]]), [[45.48, 6.02], [45.52, 6.08]]);
});

test('distanceM : distance à vol d\'oiseau plausible', async () => {
  const { distanceM } = await import('../app/js/engine/route.js');
  const d = distanceM({ lat: 45.5, lon: 6.05 }, { lat: 45.51, lon: 6.05 });
  assert.ok(d > 1050 && d < 1150, `~1,1 km attendu, obtenu ${d}`);
  assert.equal(distanceM({ lat: 45.5, lon: 6.05 }, { lat: 45.5, lon: 6.05 }), 0);
});

test('drivingUrl : itinéraire voiture Apple Plans', async () => {
  const { drivingUrl } = await import('../app/js/engine/route.js');
  const u = drivingUrl({ lat: 45.5, lon: 6.05 }, 'Véloroute');
  assert.match(u, /maps\.apple\.com/);
  assert.match(u, /daddr=45\.5,6\.05/);
  assert.match(u, /dirflg=d/);
  assert.match(u, /q=V%C3%A9loroute/);
});

test('overpassQuery + parseNature : coins nature nommés, classés par type puis proximité', async () => {
  const { overpassQuery, parseNature } = await import('../app/js/engine/route.js');
  const q = overpassQuery({ lat: 45.5, lon: 6.05 }, 5000);
  assert.match(q, /around:5000,45.5,6.05/);
  assert.match(q, /cycleway/);
  assert.match(q, /out center/);
  const json = { elements: [
    { type: 'way', tags: { name: 'Parc du Repos', leisure: 'park' }, center: { lat: 45.502, lon: 6.051 } },
    { type: 'relation', tags: { name: 'ViaRhôna', route: 'bicycle' }, center: { lat: 45.6, lon: 6.1 } },
    { type: 'way', tags: { name: 'Bois de Chartreuse', natural: 'wood' }, center: { lat: 45.505, lon: 6.06 } },
    { type: 'way', tags: { highway: 'cycleway' }, center: { lat: 45.5, lon: 6.05 } }, // sans nom : ignoré
    { type: 'way', tags: { name: 'Parc du Repos', leisure: 'park' }, center: { lat: 45.9, lon: 6.9 } }, // doublon nom
  ] };
  const r = parseNature(json, { lat: 45.5, lon: 6.05 });
  assert.equal(r[0].name, 'ViaRhôna', 'piste cyclable prioritaire');
  assert.equal(r[0].label, 'Piste cyclable');
  assert.ok(r.some((x) => x.name === 'Bois de Chartreuse' && x.label === 'Forêt'));
  assert.ok(r.find((x) => x.name === 'Parc du Repos').distanceM < 500, 'le parc proche est gardé, pas le lointain');
  assert.equal(r.filter((x) => x.name === 'Parc du Repos').length, 1, 'doublon retiré');
});
