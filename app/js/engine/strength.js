// Renforcement chevilles / genoux / hanches : 2 × ~15 min par semaine, sans matériel.
//
// Pourquoi : en reprise, le cardio progresse plus vite que les tendons (Achille, rotulien) et les
// ligaments de cheville ; avec le futsal (appuis, changements de direction), c'est le risque n° 1.
// Progression en 3 niveaux (semaines 1–4, 5–8, 9+). Chaque exercice est « au temps » (minuteur montre).
// g = [catégorie, exercice] du catalogue Garmin (affichage du nom de l'exercice sur la montre).

const ex = (name, g, sets, work, rest, note) => ({ kind: 'strength', name, g, sets, work, rest, note });

export const STRENGTH_LEVELS = [
  {
    label: 'Niveau 1 — fondations',
    steps: [
      ex('Montées sur pointes', ['CALF_RAISE', 'STANDING_CALF_RAISE'], 3, 40, 20, 'Lent : 2 s en haut, 2 s pour redescendre'),
      ex('Équilibre sur une jambe', ['HIP_STABILITY', 'HIP_STABILITY'], 4, 30, 10, 'Alterne les jambes ; genou légèrement fléchi'),
      ex('Squat', ['SQUAT', 'AIR_SQUAT'], 3, 40, 20, 'Genoux dans l\'axe des pieds, descends à 90° max'),
      ex('Pont fessier', ['HIP_RAISE', 'HIP_RAISE'], 3, 40, 20, 'Serre les fessiers en haut, 2 s'),
      ex('Gainage ventral', ['PLANK', 'PLANK'], 3, 30, 20, 'Dos plat, respire'),
    ],
  },
  {
    label: 'Niveau 2 — sur une jambe',
    steps: [
      ex('Montées sur pointes, une jambe', ['CALF_RAISE', 'SINGLE_LEG_STANDING_CALF_RAISE'], 4, 40, 15, 'Alterne les jambes ; appui léger au mur si besoin'),
      ex('Fente arrière + équilibre', ['LUNGE', 'RUNNERS_LUNGE_TO_BALANCE'], 3, 45, 15, 'Remonte en équilibre sur la jambe avant, tiens 1 s'),
      ex('Fentes', ['LUNGE', 'LUNGE'], 3, 45, 20, 'Genou avant au-dessus de la cheville'),
      ex('Pont fessier, une jambe', ['HIP_RAISE', 'SINGLE_LEG_HIP_RAISE'], 4, 30, 15, 'Alterne ; bassin bien horizontal'),
      ex('Gainage latéral', ['PLANK', 'SIDE_PLANK'], 4, 30, 15, 'Alterne les côtés'),
    ],
  },
  {
    label: 'Niveau 3 — contrôle et réactivité',
    steps: [
      ex('Pointes une jambe, 3 directions', ['CALF_RAISE', '_3_WAY_SINGLE_LEG_CALF_RAISE'], 4, 45, 15, 'Pieds droits, rentrés, sortis ; alterne'),
      ex('Squat partiel une jambe', ['SQUAT', 'PARTIAL_SINGLE_LEG_SQUAT'], 4, 40, 20, 'Genou qui ne rentre pas vers l\'intérieur ; alterne'),
      ex('Sauts squat, réception souple', ['PLYO', 'JUMP_SQUAT'], 3, 20, 40, 'Réception silencieuse sur l\'avant du pied, genoux souples'),
      ex('Pont fessier, une jambe', ['HIP_RAISE', 'SINGLE_LEG_HIP_RAISE'], 4, 40, 15, 'Alterne'),
      ex('Gainage avec levée de jambe', ['PLANK', 'PLANK_WITH_LEG_LIFT'], 3, 40, 20, 'Bassin immobile'),
    ],
  },
];

export const strengthLevel = (weekIdx) => (weekIdx < 4 ? 0 : weekIdx < 8 ? 1 : 2);

export function strengthMinutes(steps) {
  return Math.round(steps.reduce((s, st) => s + st.sets * (st.work + st.rest), 0) / 60);
}

export function strengthSession(level, { afterRun = false } = {}) {
  const L = STRENGTH_LEVELS[level];
  const steps = L.steps.map((s) => ({ ...s }));
  return {
    type: 'strength',
    title: 'Renforcement',
    description: `${L.label}. Chevilles, genoux, hanches — 15 min sans matériel.${afterRun ? ' À faire juste après ton footing.' : ' Un soir au calme.'}`,
    steps, km: 0, min: strengthMinutes(steps), optional: true, level,
  };
}

/**
 * Jours de renforcement d'une semaine (0 = lundi).
 *  A : juste après le premier footing facile de la semaine ;
 *  B : un jour sans course ni sport, jamais la veille d'un sport / d'une séance dure ou longue ;
 *      à défaut, après un autre footing facile.
 */
export function strengthDays({ runDays, easyDays, hardDays = [], sportDays = [] }) {
  const a = easyDays[0] ?? runDays[0];
  const busy = new Set([...runDays, ...sportDays]);
  const avoidBefore = new Set([...sportDays, ...hardDays].map((d) => (d + 6) % 7));
  const free = [1, 3, 4, 2, 0, 5, 6].filter((d) => !busy.has(d) && !avoidBefore.has(d) && Math.abs(d - a) >= 2);
  const b = free[0] ?? easyDays.find((d) => d !== a && Math.abs(d - a) >= 2) ?? null;
  return [a, b].filter((d) => d != null);
}
