// Petits formats partagés par le moteur (sans dépendance au DOM).

export const KIND_FR = { warmup: 'Échauffement', cooldown: 'Retour au calme', recovery: 'Récupération', run: 'Course' };
export const ZONE_FR = { E: 'Endurance', M: 'Allure marathon', T: 'Seuil', I: 'VMA', R: 'Vitesse', race: 'Allure course', walk: 'Marche' };

export function fmtPace(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}`;
}

export function fmtDur(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}`;
  return s ? `${m}'${String(s).padStart(2, '0')}` : `${m} min`;
}
