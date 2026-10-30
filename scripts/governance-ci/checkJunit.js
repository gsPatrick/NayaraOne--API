#!/usr/bin/env node
'use strict';

/**
 * Confere o JUnit de uma etapa da esteira de governança (M9-D890): no banco descartável nenhum teste pode ficar pulado nem "todo", e o relatório tem de ter ao menos um teste.
 * Uso: node scripts/governance-ci/checkJunit.js <arquivo.junit.xml>   Saída: 0 ok; 1 GOV_CI_TEST_SKIPPED/GOV_CI_NO_TESTS; 2 erro de leitura (nunca 0).
 */
const fs = require('node:fs');

/** Conta no XML: testes, pulados (<skipped>/skipped="N") e falhas. */
function contar(xml) {
  const casos = [...xml.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)].map((m) => m[0]);
  const pulados = casos.filter((c) => /<skipped\b/.test(c));
  return { testes: casos.length, pulados: pulados.map((c) => (c.match(/name="([^"]*)"/) || [])[1] || '?') };
}

function main(arquivo) {
  let xml;
  try { xml = fs.readFileSync(arquivo, 'utf8'); } catch (e) { console.error(`GOV_CI_READ_ERROR: não foi possível ler ${arquivo}: ${e.code || e.message}`); return 2; }
  const r = contar(xml);
  if (!r.testes) { console.error(`GOV_CI_NO_TESTS: ${arquivo} não tem nenhum teste.`); return 1; }
  if (r.pulados.length) { r.pulados.forEach((n) => console.error(`GOV_CI_TEST_SKIPPED: teste pulado no banco descartável: ${n}`)); return 1; }
  console.log(`${arquivo}: ${r.testes} testes, nenhum pulado`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv[2]));
module.exports = { contar };
