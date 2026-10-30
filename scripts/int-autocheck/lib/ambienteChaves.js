'use strict';

/** Chaves `integration.*` que o código declara como parâmetro (SETTINGS_SCHEMA): `'integration.x.y': { type: ... }` em qualquer arquivo de src/features/integrations ou do serviço de settings. */
const fs = require('node:fs');
const path = require('node:path');

const DECLARACAO = /['"](integration\.[a-z0-9_.]+)['"]\s*:\s*\{\s*type\b/g;

function arquivos(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) arquivos(p, acc); else if (/\.js$/.test(e.name)) acc.push(p);
  }
  return acc;
}

function chavesDeCodigo(base) {
  const lista = [...arquivos(path.join(base, 'src/features/integrations')), ...arquivos(path.join(base, 'src/features/settings'))];
  return new Set(lista.flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(DECLARACAO)].map((m) => m[1])));
}

module.exports = { chavesDeCodigo };
