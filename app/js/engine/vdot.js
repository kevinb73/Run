// Modèle VDOT (Jack Daniels & Gilbert, 1979).
// Relie une performance (distance, temps) à un "VO2max effectif" (VDOT),
// puis dérive des allures d'entraînement et des prédictions de course.

// Coût en O2 (ml/kg/min) à une vitesse v (m/min)
function vo2AtVelocity(v) {
  return -4.6 + 0.182258 * v + 0.000104 * v * v;
}

// Fraction de VO2max soutenable pendant t minutes
function fractionForDuration(tMin) {
  return 0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);
}

// Vitesse (m/min) correspondant à une consommation d'O2 donnée
function velocityAtVo2(vo2) {
  const a = 0.000104, b = 0.182258, c = -4.6 - vo2;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

/** VDOT à partir d'une performance : distance en mètres, temps en secondes. */
export function vdotFromPerformance(distanceM, timeSec) {
  const tMin = timeSec / 60;
  const v = distanceM / tMin;
  return vo2AtVelocity(v) / fractionForDuration(tMin);
}

/** Temps prédit (secondes) sur une distance pour un VDOT donné (bissection). */
export function predictTime(vdot, distanceM) {
  let lo = 60, hi = 60 * 60 * 10; // 1 min → 10 h
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    // VDOT décroît quand le temps augmente
    if (vdotFromPerformance(distanceM, mid) > vdot) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Allure (s/km) correspondant à un pourcentage de VDOT. */
function paceAtFraction(vdot, fraction) {
  const v = velocityAtVo2(vdot * fraction); // m/min
  return 60000 / v;
}

/**
 * Allures d'entraînement en secondes par km. Chaque zone a une fourchette [rapide, lent].
 * E = endurance fondamentale, M = allure marathon, T = seuil, I = intervalles (VO2max), R = répétitions (vitesse).
 */
export function trainingPaces(vdot) {
  const mPace = predictTime(vdot, 42195) / 42.195;
  const iPace = paceAtFraction(vdot, 0.975);
  return {
    E: [paceAtFraction(vdot, 0.74), paceAtFraction(vdot, 0.62)],
    M: [mPace - 3, mPace + 3],
    T: [paceAtFraction(vdot, 0.88) - 3, paceAtFraction(vdot, 0.88) + 3],
    I: [iPace - 3, iPace + 3],
    R: [iPace - 18, iPace - 10],
  };
}

/** Allure de course (s/km) sur une distance pour un VDOT donné. */
export function racePace(vdot, distanceM) {
  return predictTime(vdot, distanceM) / (distanceM / 1000);
}

/** VDOT estimé à partir de l'allure de footing (s/km) : milieu de la zone Endurance. */
export function vdotFromEasyPace(secPerKm) {
  let lo = 15, hi = 85;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const E = trainingPaces(mid).E;
    // Plus le VDOT est haut, plus l'allure est rapide (valeur en s/km plus petite).
    if ((E[0] + E[1]) / 2 > secPerKm) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
