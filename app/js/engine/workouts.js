// Bibliothèque de séances. Chaque séance est décrite en "étapes" structurées
// (échauffement, effort, récupération, répétitions...) : c'est ce format qui sera
// converti plus tard en séance Garmin.

const step = (kind, dur, zone, pace, note) => ({ kind, dur, zone, pace, note });
const dist = (m) => ({ type: 'distance', m });
const time = (s) => ({ type: 'time', s });
const repeat = (times, steps) => ({ kind: 'repeat', times, steps });

const round05 = (x) => Math.round(x * 2) / 2;

/** Sélectionne une variante dans une progression selon l'avancement p ∈ [0,1]. */
function pick(options, p) {
  const i = Math.min(options.length - 1, Math.max(0, Math.round(p * (options.length - 1))));
  return options[i];
}

/** Distance estimée (km) et durée (min) d'une liste d'étapes. */
export function estimate(steps, paces) {
  let m = 0, s = 0;
  const walk = (list, mult) => {
    for (const st of list) {
      if (st.kind === 'repeat') { walk(st.steps, mult * st.times); continue; }
      if (st.kind === 'strength') { s += st.sets * (st.work + st.rest) * mult; continue; }
      const pace = st.zone === 'walk' ? 600 // marche active ≈ 10 min/km
        : st.pace ? (st.pace[0] + st.pace[1]) / 2 : (paces.E[0] + paces.E[1]) / 2 + 30; // trot
      if (st.dur.type === 'distance') { m += st.dur.m * mult; s += (st.dur.m / 1000) * pace * mult; }
      else { s += st.dur.s * mult; m += (st.dur.s / pace) * 1000 * mult; }
    }
  };
  walk(steps, 1);
  return { km: Math.round(m / 100) / 10, min: Math.round(s / 60) };
}

const warmup = (c, km = 2) => step('warmup', dist(km * 1000), 'E', c.paces.E, 'Footing progressif');
const cooldown = (c, km = 1.5) => step('cooldown', dist(km * 1000), 'E', c.paces.E, 'Retour au calme');
const jog = (s) => step('recovery', time(s), null, null, 'Trot récupération');

function session(type, title, description, steps) {
  return { type, title, description, steps };
}

// ---------- Séances ----------

export function easyRun(c, km, { strides = false } = {}) {
  const steps = [step('run', dist(round05(km) * 1000), 'E', c.paces.E, 'Aisance respiratoire : tu dois pouvoir parler')];
  if (strides) {
    steps.push(repeat(5, [
      step('run', time(20), 'R', c.paces.R, 'Accélération fluide, relâché'),
      step('recovery', time(60), null, null, 'Marche / trot'),
    ]));
  }
  return session(
    'easy',
    strides ? 'Footing + lignes droites' : 'Footing',
    strides
      ? "Endurance fondamentale puis 5 accélérations courtes pour travailler la foulée sans fatigue."
      : "Endurance fondamentale. C'est la base de la progression : la lenteur est voulue.",
    steps,
  );
}

export function longRun(c, km, { finishZone = null, finishKm = 0 } = {}) {
  km = round05(km);
  if (!finishZone || finishKm <= 0) {
    return session('long', 'Sortie longue', 'Endurance fondamentale, régulière. Bois et teste ton ravitaillement si > 1h15.', [
      step('run', dist(km * 1000), 'E', c.paces.E, 'Allure facile et constante'),
    ]);
  }
  const pace = finishZone === 'race' ? c.racePaceRange : c.paces[finishZone];
  const label = finishZone === 'race' ? 'allure objectif' : 'allure marathon';
  return session('long', `Sortie longue avec ${finishKm} km à ${label}`, `Fin de sortie longue à ${label} pour apprendre à tenir l'allure en fatigue.`, [
    step('run', dist((km - finishKm) * 1000), 'E', c.paces.E, 'Allure facile'),
    step('run', dist(finishKm * 1000), finishZone === 'race' ? 'race' : 'M', pace, `Bloc à ${label}`),
  ]);
}

export function threshold(c, p) {
  const v = pick([
    [4, 300, 60], [3, 480, 90], [5, 360, 60], [3, 600, 120], [4, 480, 60], [2, 900, 120], [3, 720, 90], [1, 1500, 0],
  ], p);
  const [n, effort, rec] = v;
  const block = [step('run', time(effort), 'T', c.paces.T, 'Seuil : effort "confortablement difficile"')];
  if (rec) block.push(jog(rec));
  const label = n === 1 ? `${effort / 60} min continu` : `${n} × ${effort / 60} min`;
  return session('threshold', `Seuil — ${label}`, "Développe ta capacité à tenir longtemps une allure soutenue (seuil lactique).", [
    warmup(c), n === 1 ? block[0] : repeat(n, block), cooldown(c),
  ]);
}

export function intervals(c, p) {
  const [n, m, rec] = pick([[5, 800, 120], [6, 800, 120], [5, 1000, 150], [6, 1000, 150], [4, 1200, 180], [5, 1200, 180]], p);
  return session('intervals', `VMA — ${n} × ${m} m`, 'Intervalles à allure VO2max : récupère en trottinant, la qualité prime sur la quantité.', [
    warmup(c, 2.5),
    repeat(n, [step('run', dist(m), 'I', c.paces.I, 'Allure intervalle (VO2max)'), jog(rec)]),
    cooldown(c),
  ]);
}

export function hills(c, p) {
  const n = pick([6, 7, 8, 9, 10], p);
  return session('hills', `Côtes — ${n} × 45 s`, "Montées dynamiques (effort fort, pas sprint), redescente en trottinant. Renforce sans traumatiser.", [
    warmup(c, 2.5),
    repeat(n, [step('run', time(45), 'I', null, 'Montée : genoux hauts, buste droit'), step('recovery', time(90), null, null, 'Redescente en trottinant')]),
    cooldown(c),
  ]);
}

export function fartlek(c, p) {
  const n = pick([6, 8, 10, 12], p);
  return session('fartlek', `Fartlek — ${n} × 1 min`, 'Variations d\'allure ludiques : 1 min soutenue, 1 min facile.', [
    warmup(c),
    repeat(n, [step('run', time(60), 'T', [c.paces.I[0], c.paces.T[1]], 'Soutenu'), step('recovery', time(60), 'E', c.paces.E, 'Facile')]),
    cooldown(c),
  ]);
}

/** Séance spécifique à l'allure objectif, dépend de la distance de course. */
export function raceSpecific(c, p) {
  const rp = c.racePaceRange;
  const d = c.raceDistance;
  let n, m, rec;
  if (d <= 5000) [n, m, rec] = pick([[6, 600, 90], [5, 800, 90], [5, 1000, 120], [4, 1200, 120], [3, 1600, 150]], p);
  else if (d <= 10000) [n, m, rec] = pick([[5, 1000, 90], [4, 1500, 90], [3, 2000, 120], [4, 2000, 120], [2, 3000, 120]], p);
  else if (d <= 21097) [n, m, rec] = pick([[3, 2000, 90], [3, 3000, 120], [2, 5000, 150], [3, 4000, 120], [2, 6000, 150]], p);
  else [n, m, rec] = pick([[2, 4000, 120], [2, 5000, 120], [3, 4000, 120], [2, 7000, 150], [1, 12000, 0], [1, 14000, 0]], p);

  const label = n === 1 ? `${m / 1000} km` : `${n} × ${m >= 1000 ? m / 1000 + ' km' : m + ' m'}`;
  const block = [step('run', dist(m), 'race', rp, 'Allure objectif course')];
  if (rec) block.push(jog(rec));
  return session('race-pace', `Allure course — ${label}`, "Le cœur de la préparation : habituer ton corps à l'allure exacte du jour J.", [
    warmup(c), n === 1 ? block[0] : repeat(n, block), cooldown(c),
  ]);
}

/** Rappel d'allure de semaine de course : court, vif, sans fatigue. */
export function sharpener(c) {
  return session('race-pace', 'Rappel allure course', 'Quelques minutes à allure objectif pour garder les sensations. Tu dois finir frais.', [
    warmup(c),
    repeat(4, [step('run', time(90), 'race', c.racePaceRange, 'Allure objectif'), jog(90)]),
    cooldown(c, 1),
  ]);
}

export function raceDay(c, label, goalTimeText) {
  return session('race', `Course — ${label}`, `Jour J. Objectif : ${goalTimeText}. Pars prudemment : le premier km ne doit pas être plus rapide que l'allure prévue.`, [
    step('warmup', time(600), 'E', c.paces.E, 'Échauffement léger 10 min + quelques accélérations'),
    step('run', dist(c.raceDistance), 'race', c.racePaceRange, 'Allure objectif, régulière'),
  ]);
}

/** Test chrono de fin de cycle (mode remise en forme). */
export function testRun(c, optional = false) {
  return session('race', optional ? 'Test 5 km (facultatif)' : 'Test 5 km',
    'Bilan du cycle : 5 km le plus vite possible mais de façon régulière. Ton chrono recalibre le cycle suivant.', [
      step('warmup', time(600), 'E', c.paces.E, 'Échauffement 10 min + 3 accélérations'),
      step('run', dist(5000), 'race', c.racePaceRange, 'Effort maximal régulier'),
      step('cooldown', time(300), 'E', c.paces.E, 'Retour au calme'),
    ]);
}

/** Séance de reprise : alternance course / marche, encadrée par de la marche. */
export function runWalk(c, runSec, walkSec, reps, final = false) {
  const walkStep = (s, kind, note) => step(kind, time(s), 'walk', null, note);
  const runStep = step('run', time(runSec), 'E', c.paces.E, 'Course très facile : tu dois pouvoir parler');
  const main = reps > 1 ? repeat(reps, walkSec ? [runStep, walkStep(walkSec, 'recovery', 'Marche active')] : [runStep]) : runStep;
  const runMin = runSec % 60 ? `${Math.floor(runSec / 60)} min ${runSec % 60}` : `${runSec / 60} min`;
  const title = reps > 1 ? `Course/marche — ${reps} × ${runMin}` : `Course continue — ${runMin}`;
  return session('easy', final ? `Objectif : ${runMin} sans t'arrêter` : title,
    final ? 'Dernière séance du cycle : cours sans t\'arrêter, à ton rythme. Si tu y arrives, tu es prêt pour le mode « Courir régulièrement ».'
      : 'Alternance course et marche. Le but n\'est pas la vitesse : finir la séance en ayant pu parler tout du long.', [
      walkStep(300, 'warmup', 'Marche dynamique'), main, walkStep(300, 'cooldown', 'Marche tranquille'),
    ]);
}

/** Test 6 minutes (demi-Cooper) : la distance parcourue donne la VMA (km/h = mètres / 100). */
export function vmaTest(c) {
  return session('test', 'Test 6 min (VMA)',
    "Après l'échauffement, cours 6 minutes le plus loin possible, à un rythme que tu peux tenir jusqu'au bout (pars un peu prudemment, accélère sur la dernière minute). La distance recalibre toutes tes allures.", [
      step('warmup', time(900), 'E', c.paces.E, 'Footing très facile'),
      repeat(3, [step('run', time(20), 'R', null, 'Accélération progressive'), step('recovery', time(60), null, null, 'Trot')]),
      step('recovery', time(120), null, null, 'Marche / trot, prépare-toi'),
      step('run', time(360), 'I', null, 'TEST : 6 min le plus loin possible'),
      step('cooldown', time(600), 'E', c.paces.E, 'Retour au calme, très lent'),
    ]);
}
