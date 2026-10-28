#!/usr/bin/env node
'use strict';

// Portão de CI do M9-D001: reprova (exit 1) se src/modules/ai/** ou o resto de src/ violar AI-002/AI-004.
// Uso: node scripts/ai-arch-guard.js [--raiz <pasta>]   (a raiz alternativa serve ao teste da fixture)
const path = require('node:path');
const { varrer, varrerSdkFornecedorNoRestoDoCodigo, formatar } = require('./lib/aiArchGuard');

const i = process.argv.indexOf('--raiz');
const raiz = i > -1 ? path.resolve(process.argv[i + 1]) : undefined;
const violacoes = [...varrer(raiz), ...(raiz ? [] : varrerSdkFornecedorNoRestoDoCodigo())];
const commit = process.env.GITHUB_SHA || 'local';
if (violacoes.length) {
  console.error(`archGuard da NAY: ${violacoes.length} violação(ões) [commit ${commit}]\n${formatar(violacoes)}`);
  process.exit(1);
}
console.log(`archGuard da NAY: 0 violações [commit ${commit}] em ${new Date().toISOString()}`);
