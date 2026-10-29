#!/usr/bin/env node
'use strict';

// Portão de CI das fronteiras de integração (M9-D210) e da verificação de certificado (M9-D244): sai com 1 se houver violação.
// Uso: node scripts/checkIntegrationBoundaries.js [--raiz <pasta src>]   (a raiz alternativa serve ao teste da fixture)
const path = require('node:path');
const { scanBoundaries, scanTlsVerification, formatar } = require('./lib/integrationBoundaries');

const i = process.argv.indexOf('--raiz');
const srcRoot = i > -1 ? path.resolve(process.argv[i + 1]) : undefined;
const violacoes = [...scanBoundaries({ srcRoot }), ...(srcRoot ? [] : scanTlsVerification())];
const commit = process.env.GITHUB_SHA || 'local';
if (violacoes.length) {
  console.error(`fronteiras de integração: ${violacoes.length} violação(ões) [commit ${commit}]\n${formatar(violacoes)}`);
  process.exit(1);
}
console.log(`fronteiras de integração: 0 violações [commit ${commit}] em ${new Date().toISOString()}`);
