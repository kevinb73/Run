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
