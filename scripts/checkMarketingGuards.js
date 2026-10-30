#!/usr/bin/env node
'use strict';

// Portão de CI das 8 guardas "Não improvisar" do Marketing (M9-D440): sai com 1 e imprime MKT_GUARD_VIOLATION com guarda, arquivo, linha e regra de cada violação.
// Uso: node scripts/checkMarketingGuards.js [--raiz <pasta da API>]   (a raiz alternativa serve ao teste da cópia com a violação injetada)
const path = require('node:path');
const { rodarTodas, formatar } = require('./marketing/guards');

const i = process.argv.indexOf('--raiz');
const resultado = rodarTodas(i > -1 ? path.resolve(process.argv[i + 1]) : undefined);
const violacoes = resultado.flatMap((r) => r.violacoes);
if (violacoes.length) {
  violacoes.forEach((v) => console.error(formatar(v)));
  console.error(`MKT_GUARD_VIOLATION ${violacoes.length} violação(ões) em ${new Set(violacoes.map((v) => v.guarda)).size} guarda(s) [commit ${process.env.GITHUB_SHA || 'local'}]`);
  process.exit(1);
}
console.log(`guardas do marketing: ${resultado.length} guardas, 0 violações [commit ${process.env.GITHUB_SHA || 'local'}]`);
