#!/usr/bin/env node
'use strict';

/**
 * checkAdversarialMap (M9-D890, Caderno §11): confere que os 10 testes adversariais do bloco de governança existem com o nome do mapa e não estão skip/todo.
 * Uso: node scripts/checkAdversarialMap.js [--mapa <arquivo>] [--raiz <pasta>]... [--json <saida.json>]
 * Saída: 0 com 10 de 10 presentes; 1 com GOV_ADVERSARIAL_MISSING (nome ausente, skip ou todo) ou mapa incoerente; 2 em erro de leitura (nunca 0).
 */
const fs = require('node:fs');
const path = require('node:path');
const { verificarMapa, LeituraError, MAPA_PADRAO, CODIGO_AUSENTE, MENSAGEM_AUSENTE } = require('./governance-ci/adversarialMap');

function opcoes(argv) {
  const o = { mapa: MAPA_PADRAO, raizes: [], json: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--mapa') { o.mapa = path.resolve(argv[i + 1]); i += 1; } else if (argv[i] === '--raiz') { o.raizes.push(path.resolve(argv[i + 1])); i += 1; } else if (argv[i] === '--json') { o.json = path.resolve(argv[i + 1]); i += 1; }
  }
  return o;
}

function main() {
  const o = opcoes(process.argv.slice(2));
  let r;
  try { r = verificarMapa({ mapa: o.mapa, raizes: o.raizes.length ? o.raizes : null }); } catch (e) {
    if (e instanceof LeituraError) { console.error(`GOV_ADVERSARIAL_READ_ERROR: ${e.message}`); return 2; }
    throw e;
  }
  r.problemas.forEach((p) => console.error(`mapa: ${p}`));
  r.ausentes.forEach((a) => console.error(`${CODIGO_AUSENTE}: ${MENSAGEM_AUSENTE} ${a.nome} (item ${a.item}, ${a.demanda}, ${a.motivo}).`));
  const presentes = r.total - r.ausentes.length;
  console.log(`testes adversariais do bloco de governança: ${r.itens} itens, ${presentes} de ${r.total} nomes presentes e ativos, ${r.ausentes.length} ausentes, ${r.problemas.length} problemas no mapa`);
  if (o.json) {
    try { fs.mkdirSync(path.dirname(o.json), { recursive: true }); fs.writeFileSync(o.json, `${JSON.stringify(r, null, 2)}\n`); } catch (e) { console.error(`GOV_ADVERSARIAL_READ_ERROR: não foi possível gravar ${o.json}: ${e.code || e.message}`); return 2; }
  }
  return r.ok ? 0 : 1;
}

process.exit(main());
