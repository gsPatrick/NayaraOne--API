#!/usr/bin/env node
'use strict';
/**
 * Portão de CI dos códigos de erro (M9-D843 §3.4 e K4): varre src/features/core-governance e reprova (exit 1) o código que não está no catálogo (GOV_ERROR_CODE_UNKNOWN), o que
 * não começa com GOV_ fora da lista fechada, a entrada incompleta e o docs/ERROR_CODES.md desatualizado. Os códigos legados da API fora dessa pasta não são varridos.
 *   node scripts/checkErrorCodes.js [--dir <pasta>] [--catalog <json>]
 */
const fs = require('node:fs');
const path = require('node:path');
const { checkCatalog } = require('../src/features/core-governance/api-governance/standards/errorCatalog.build');
const { entriesFromData, readData } = require('../src/features/core-governance/api-governance/standards/errorCatalog.data');
const { renderMarkdown } = require('../src/features/core-governance/api-governance/standards/errorCatalog.markdown');

const ROOT = path.resolve(__dirname, '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const dir = path.resolve(arg('--dir') || path.join(ROOT, 'src/features/core-governance'));
const data = arg('--catalog') ? JSON.parse(fs.readFileSync(arg('--catalog'), 'utf8')) : readData();
const problems = checkCatalog({ dir, data });
if (!arg('--dir') && !arg('--catalog')) {
  const doc = path.join(ROOT, 'docs/ERROR_CODES.md');
  if (!fs.existsSync(doc) || fs.readFileSync(doc, 'utf8') !== renderMarkdown(entriesFromData(data))) problems.push({ rule: 'GOV_ERROR_CODE_DOC_STALE', message: 'docs/ERROR_CODES.md está desatualizado: rode node scripts/gerarErrorCatalog.js.' });
}
for (const p of problems) console.error(`${p.rule} ${p.message}`);
console.log(problems.length ? `FALHOU: ${problems.length} problema(s) nos códigos de erro.` : `OK: códigos de erro de ${path.relative(ROOT, dir) || '.'} todos no catálogo.`);
process.exit(problems.length ? 1 : 0);
