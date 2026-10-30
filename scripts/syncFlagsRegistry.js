#!/usr/bin/env node
'use strict';

/**
 * M9-D871 §3.3 — ÚNICO gerador do arquivo de flags declaradas (docs/governance/flags.json).
 *   npm run sync:flags              exporta para o arquivo as flags declaradas nos seeds (src/features/core-governance/feature-flags/seeds/*.seed.js)
 *   npm run sync:flags -- --check   confere o arquivo contra os seeds: exit 1 se divergem (nada é escrito)
 *   --seeds <pasta> / --out <arquivo>   outra pasta de seeds ou outro destino (usado nos testes)
 * Sem banco: o CI enxerga só o que está versionado. Seed inválido (temporária sem validade, chave repetida ou fora do formato) sai com código 1 e não escreve o arquivo.
 */
const fs = require('node:fs');
const path = require('node:path');
const { SEEDS_DIR, REGISTRY_FILE, buildRegistryText } = require('../src/features/core-governance/feature-flags/registry/registry.file');

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const seeds = path.resolve(arg('--seeds') || SEEDS_DIR);
const out = path.resolve(arg('--out') || REGISTRY_FILE);

let text;
try { text = buildRegistryText(seeds); } catch (err) { console.error(err.message); process.exit(1); }

if (process.argv.includes('--check')) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  if (current !== text) { console.error(`${path.relative(process.cwd(), out)} está desatualizado em relação aos seeds: rode npm run sync:flags.`); process.exit(1); }
  console.log('OK: o arquivo de flags está em dia com os seeds.');
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`Gravado ${path.relative(process.cwd(), out)} (${JSON.parse(text).flags.length} flag(s)).`);
}
