#!/usr/bin/env node
'use strict';

/**
 * checkAdversarialNames (M9-D251, Guia §19 e §20): confere que os 15 itens do livro e os 18 nomes de teste adversarial do manifesto existem nos arquivos de teste.
 * Uso: node scripts/checkAdversarialNames.js [--manifesto <arquivo>] [--raiz <pasta>]... [--ate-parte 1]
 * Saída 0 só com tudo presente; nome ausente imprime INTEGRATION_ADVERSARIAL_NAME_MISSING com o nome, o item e a parte, e sai com 1.
 */
const path = require('node:path');
const { verificarNomes, CODIGO_AUSENTE, MENSAGEM_AUSENTE, MANIFESTO_PADRAO } = require('./int-ci/lib/adversarial');

function opcoes(argv) {
  const o = { manifesto: MANIFESTO_PADRAO, raizes: [], ateParte: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifesto') { o.manifesto = path.resolve(argv[i + 1]); i += 1; } else if (argv[i] === '--raiz') { o.raizes.push(path.resolve(argv[i + 1])); i += 1; } else if (argv[i] === '--ate-parte') { o.ateParte = Number(argv[i + 1]); i += 1; }
  }
  if (!o.raizes.length) delete o.raizes;
  return o;
}

const r = verificarNomes(opcoes(process.argv.slice(2)));
r.problemas.forEach((p) => console.error(`manifesto: ${p}`));
r.ausentes.forEach((a) => console.error(`${CODIGO_AUSENTE}: ${MENSAGEM_AUSENTE} ${a.nome} (item ${a.item}, parte ${a.parte})`));
console.log(`testes adversariais: ${r.itens} itens, ${r.total} nomes conferidos, ${r.ausentes.length} ausentes, ${r.problemas.length} problemas no manifesto`);
process.exit(r.ok ? 0 : 1);
