// Icônes au trait (24×24), couleur héritée du texte (currentColor).

const svg = (path) => `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

export const ICONS = {
  easy: svg('<circle cx="13" cy="4" r="2"/><path d="M8 21l3-6 3 2v5"/><path d="M6 12l3-4 5 1 3 3"/><path d="M11 15l-1-4"/>'),
  long: svg('<path d="M4 20c4-8 12-8 16-16"/><circle cx="4" cy="20" r="1.5"/><circle cx="20" cy="4" r="1.5"/>'),
  threshold: svg('<path d="M3 17l5-5 4 3 8-8"/><path d="M15 7h5v5"/>'),
  intervals: svg('<path d="M5 20V10M10 20V5M15 20v-8M20 20V8"/>'),
  hills: svg('<path d="M2 20l7-11 4 6 3-4 6 9z"/>'),
  fartlek: svg('<path d="M2 12c3-6 5 6 8 0s5 6 8 0 3-3 4-2"/>'),
  'race-pace': svg('<circle cx="12" cy="13" r="8"/><path d="M12 13l3-3M10 2h4"/>'),
  race: svg('<path d="M5 21V4h10l-1 4h5l-2 6H6"/>'),
  test: svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>'),
  futsal: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7l4 3-1.5 5h-5L8 10z"/>'),
  referee: svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  today: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  plan: svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>'),
  progress: svg('<path d="M3 17l5-5 4 3 8-8"/><path d="M15 7h5v5"/>'),
  profile: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>'),
  pause: svg('<path d="M9 5v14M15 5v14"/>'),
  watch: svg('<rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 6V3h6v3M9 18v3h6v-3"/>'),
};
