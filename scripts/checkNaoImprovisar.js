#!/usr/bin/env node
'use strict';

// Portão de CI das 7 guardas do "Não improvisar" (M9-D257): sai com 1 e imprime arquivo e linha de cada violação (ARCH_RULE_VIOLATION). Exceção só pelo excecoes.json, com approvedBy.
// Uso: node scripts/checkNaoImprovisar.js [--raiz <pasta do projeto>]   (a raiz alternativa serve ao teste da fixture)
const path = require('node:path');
const { runAll, formatar } = require('./lib/naoImprovisar');

const i = process.argv.indexOf('--raiz');
const root = i > -1 ? path.resolve(process.argv[i + 1]) : undefined;
const resultado = runAll(root ? { root } : {});
const violacoes = resultado.flatMap((r) => r.violations);
const commit = process.env.GITHUB_SHA || 'local';
if (violacoes.length) {
  console.error(`ARCH_RULE_VIOLATION Regra de arquitetura de integrações violada: ${violacoes.length} violação(ões) [commit ${commit}]\n${formatar(violacoes)}`);
  process.exit(1);
}
console.log(`nao improvisar: ${resultado.length} guardas, 0 violações [commit ${commit}] em ${new Date().toISOString()}`);
