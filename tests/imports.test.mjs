// Vérification statique : chaque nom importé entre modules de l'app est bien exporté par le module visé.
// (Une erreur ici empêche l'app de démarrer sur l'iPhone, sans aucun message.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', 'app', 'js');
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })(ROOT);

function exportsOf(file) {
  const src = readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) for (const n of m[1].split(',')) names.add(n.trim().split(/\s+as\s+/).pop());
  return names;
}

test('imports entre modules : tous les noms existent', () => {
  const problems = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/^import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)';/gm)) {
      const target = resolve(dirname(f), m[2]);
      let exp;
      try { exp = exportsOf(target); } catch { problems.push(`${f} → fichier introuvable ${m[2]}`); continue; }
      for (const n of m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        if (!exp.has(n)) problems.push(`${f.replace(ROOT, 'app/js')} importe « ${n} » absent de ${m[2]}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('service worker : tous les modules sont mis en cache (fonctionnement hors ligne)', () => {
  const sw = readFileSync(join(ROOT, '..', 'sw.js'), 'utf8');
  const missing = files.map((f) => './js/' + f.slice(ROOT.length + 1)).filter((p) => !sw.includes(`'${p}'`));
  assert.deepEqual(missing, []);
});
