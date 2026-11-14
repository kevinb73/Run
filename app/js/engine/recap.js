// Récap de séance : chiffres clés, prévu / réalisé, détail par étape et conclusion de coach.
// Logique pure (testée) : l'écran se contente d'afficher ce que renvoie buildRecap().

import { flattenSteps, QUALITY_TYPES } from './analysis.js';
import { KIND_FR, ZONE_FR, fmtPace, fmtDur } from './recap-format.js';

const TOL = 5;

function plannedOf(session, paces) {
  const flat = flattenSteps(session.steps);
  const runPaces = flat.filter((s) => s.kind === 'run' && s.pace).map((s) => s.pace);
  return { km: session.km, min: session.min, steps: flat, mainPace: runPaces[0] ?? paces?.E ?? null };
}

/** Détail étape par étape (si la séance a été lancée depuis la montre : un tour par étape). */
export function stepRows(session, laps) {
  const flat = flattenSteps(session.steps);
  if (!Array.isArray(laps) || laps.length < flat.length || laps.length > flat.length + 1) return null;
  return flat.map((st, i) => {
    const lap = laps[i];
    const pace = lap.distanceM > 0 ? lap.durationSec / (lap.distanceM / 1000) : null;
    let status = null;
    if (st.kind === 'run' && st.pace && pace) status = pace > st.pace[1] + TOL ? 'slow' : pace < st.pace[0] - TOL ? 'fast' : 'ok';
    const planned = st.dur.type === 'distance' ? `${st.dur.m >= 1000 ? (st.dur.m / 1000).toLocaleString('fr-FR') + ' km' : st.dur.m + ' m'}` : fmtDur(st.dur.s);
    return {
      label: st.zone ? ZONE_FR[st.zone] ?? KIND_FR[st.kind] : KIND_FR[st.kind] ?? 'Étape',
      planned,
      target: st.pace ? `${fmtPace(st.pace[0])}–${fmtPace(st.pace[1])}` : null,
      actual: `${(lap.distanceM / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} km · ${fmtDur(lap.durationSec)}${pace && st.kind === 'run' ? ` · ${fmtPace(pace)}/km` : ''}`,
      hr: lap.avgHr ?? null,
      status,
    };
  });
}

/**
 * @param session séance ; entry : journal (données Garmin, ressenti, analyse) ;
 * @param ctx { paces (de la semaine), hr: {maxHr, restHr}, next: prochaine séance }
 */
export function buildRecap(session, entry, ctx = {}) {
  const e = entry ?? {};
  const plan = plannedOf(session, ctx.paces);
  const stats = [];
  const add = (label, value) => { if (value != null && value !== '') stats.push({ label, value }); };
  add('Distance', e.actualKm != null ? `${e.actualKm.toLocaleString('fr-FR')} km` : null);
  add('Durée', e.durationSec ? fmtDur(e.durationSec) : null);
  add('Allure moyenne', e.paceSecPerKm ? `${fmtPace(e.paceSecPerKm)}/km` : null);
  add('FC moyenne', e.avgHr ? `${e.avgHr} bpm${ctx.hr?.maxHr ? ` (${Math.round((e.avgHr / ctx.hr.maxHr) * 100)} % max)` : ''}` : null);
  add('FC max', e.maxHr ? `${e.maxHr} bpm` : null);
  add('Calories', e.calories ? `${Math.round(e.calories)} kcal` : null);
  add('Dénivelé +', e.elevationGainM != null ? `${Math.round(e.elevationGainM)} m` : null);
  add('Cadence', e.cadence ? `${Math.round(e.cadence)} pas/min` : null);
  add('Effet aérobie', e.trainingEffect ? `${e.trainingEffect.toFixed(1).replace('.', ',')} / 5` : null);
  add('Charge', e.trainingLoad ? `${Math.round(e.trainingLoad)}` : null);

  // Prévu / réalisé
  const compare = [];
  if (e.actualKm != null && plan.km) {
    const ratio = e.actualKm / plan.km;
    compare.push({ label: 'Distance', planned: `${plan.km.toLocaleString('fr-FR')} km`, done: `${e.actualKm.toLocaleString('fr-FR')} km`, ok: ratio >= 0.9 && ratio <= 1.15 });
  }
  if (e.durationSec && plan.min) {
    compare.push({ label: 'Durée', planned: `~${plan.min} min`, done: fmtDur(e.durationSec), ok: Math.abs(e.durationSec / 60 - plan.min) / plan.min <= 0.15 });
  }
  if (e.paceSecPerKm && ['easy', 'long'].includes(session.type) && ctx.paces?.E) {
    const [f, sl] = ctx.paces.E;
    compare.push({ label: 'Allure', planned: `${fmtPace(f)}–${fmtPace(sl)}`, done: fmtPace(e.paceSecPerKm), ok: e.paceSecPerKm >= f - 10 && e.paceSecPerKm <= sl + 30 });
  }

  const steps = stepRows(session, e.laps);
  return { stats, compare, steps, conclusion: conclusion(session, e, plan, ctx) };
}

/** 2–3 phrases : ce qui s'est passé, ce que ça veut dire, ce qui vient ensuite. */
export function conclusion(session, e, plan, ctx) {
  const a = e.analysis;
  const v = a?.verdict ?? (e.feel === 'hard' ? 'hard' : 'success');
  const out = [];
  const short = e.actualKm != null && plan.km && e.actualKm < plan.km * 0.8;
  const hrPct = e.avgHr && ctx.hr?.maxHr ? e.avgHr / ctx.hr.maxHr : null;

  if (session.type === 'easy' || session.type === 'long') {
    if (v === 'fast') out.push(`Trop rapide pour un footing : à ${fmtPace(e.paceSecPerKm)}/km, tu travailles une autre filière que l'endurance de base.`);
    else if (v === 'hard') out.push('Séance ressentie dure : ce n\'est pas un échec, c\'est une information. Le plan en tient compte.');
    else out.push(`Footing réussi${e.paceSecPerKm ? ` à ${fmtPace(e.paceSecPerKm)}/km` : ''} : c'est exactement ce qui construit ton endurance.`);
    if (hrPct != null) {
      if (hrPct > 0.82) out.push(`Ton cœur était à ${Math.round(hrPct * 100)} % de ta FC max : c'est haut pour un footing. Ralentis la prochaine fois, quitte à marcher quelques secondes.`);
      else out.push(`Cœur à ${Math.round(hrPct * 100)} % de ta FC max : bien dans la zone d'endurance ✓`);
    }
    if (short) out.push('Distance un peu en dessous du prévu : pas grave, la régularité compte plus que chaque kilomètre.');
  } else if (QUALITY_TYPES.includes(session.type) || session.type === 'test') {
    if (v === 'success') out.push('Séance réussie : allures tenues sur la majorité des répétitions.');
    else if (v === 'hard') out.push('Séance trop dure : les allures n\'ont pas tenu jusqu\'au bout.');
    else if (v === 'easy') out.push('Séance facile pour toi : tu as de la marge.');
    if (a?.details?.length) out.push(a.details.find((d) => d.includes('baisse') || d.includes('plus rapides')) ?? '');
    out.push(a?.note ?? (v === 'success' ? 'La progression continue comme prévu.' : ''));
  } else {
    out.push(v === 'hard' ? 'Séance ressentie dure : on en tient compte.' : 'Séance faite ✓');
  }
  if (ctx.next) out.push(`Prochaine séance : ${ctx.next.title} (${ctx.next.dateLabel}).`);
  return out.filter(Boolean);
}
