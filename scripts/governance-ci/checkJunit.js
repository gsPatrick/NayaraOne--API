#!/usr/bin/env node
'use strict';

/**
 * Confere o JUnit de uma etapa da esteira de governança (M9-D890): no banco descartável nenhum teste pode ficar pulado nem "todo", e o relatório tem de ter ao menos um teste.
 * Exceção única e visível: com CI_SEM_REPOS_IRMAOS=1 (o workflow declara que o CI só tem a API), o teste pulado cuja mensagem começa por NAO_APLICAVEL_NO_CI (test/helpers/repoIrmao.js)
 * não reprova, mas é LISTADO como "não aplicável no CI, coberto na suíte local" e contado à parte; nunca vira "passou". Sem a variável, qualquer pulo reprova.
 * Uso: node scripts/governance-ci/checkJunit.js <arquivo.junit.xml>   Saída: 0 ok; 1 GOV_CI_TEST_SKIPPED/GOV_CI_NO_TESTS; 2 erro de leitura (nunca 0).
 */
const fs = require('node:fs');

/** Conta no XML: testes, pulados (<skipped>/skipped="N") com a mensagem de cada um, e falhas. */
function contar(xml) {
  const casos = [...xml.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)].map((m) => m[0]);
  return { testes: casos.length, pulados: detalharPulados(casos).map((d) => d.nome) };
}

/** Os casos pulados com a mensagem de cada um. */
function detalharPulados(casos) {
  return casos.filter((c) => /<skipped\b/.test(c)).map((c) => ({ nome: (c.match(/name="([^"]*)"/) || [])[1] || '?', mensagem: (c.match(/<skipped\b[^>]*?message="([^"]*)"/) || [])[1] || '' }));
}

const NAO_APLICAVEL = /^NAO_APLICAVEL_NO_CI\b/;

function main(arquivo) {
  let xml;
  try { xml = fs.readFileSync(arquivo, 'utf8'); } catch (e) { console.error(`GOV_CI_READ_ERROR: não foi possível ler ${arquivo}: ${e.code || e.message}`); return 2; }
  const r = contar(xml);
  r.detalhe = detalharPulados([...xml.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)].map((m) => m[0]));
  if (!r.testes) { console.error(`GOV_CI_NO_TESTS: ${arquivo} não tem nenhum teste.`); return 1; }
  const declarado = process.env.CI_SEM_REPOS_IRMAOS === '1';
  const naoAplicaveis = declarado ? r.detalhe.filter((d) => NAO_APLICAVEL.test(d.mensagem)) : [];
  const pulados = r.detalhe.filter((d) => !naoAplicaveis.includes(d));
  if (pulados.length) { pulados.forEach((d) => console.error(`GOV_CI_TEST_SKIPPED: teste pulado no banco descartável: ${d.nome}`)); return 1; }
  naoAplicaveis.forEach((d) => console.log(`NAO_APLICAVEL_NO_CI (nao passou, nao foi executado): ${d.nome} -> ${d.mensagem}`));
  if (naoAplicaveis.length) console.log(`${arquivo}: ${r.testes} testes, ${r.testes - naoAplicaveis.length} executados, ${naoAplicaveis.length} NAO APLICAVEIS NO CI (artefato irmao ausente, cobertos na suite local), nenhum outro pulado`);
  else console.log(`${arquivo}: ${r.testes} testes, nenhum pulado`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv[2]));
module.exports = { contar, detalharPulados, casosDoXml: (xml) => [...xml.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)].map((m) => m[0]) };
