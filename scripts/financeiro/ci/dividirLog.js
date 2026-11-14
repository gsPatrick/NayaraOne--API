#!/usr/bin/env node
'use strict';

/**
 * Divide o log e o relatório de uma execução completa da esteira do Financeiro (`--todos`) em um par por estágio, no mesmo formato que o workflow grava
 * quando roda um estágio por passo: docs/evidencias/ci/esteira-financeiro-<N>.log e .json. O conteúdo é recortado, nunca reescrito.
 *
 *   node scripts/financeiro/ci/dividirLog.js docs/evidencias/ci/esteira-financeiro.log
 */
const fs = require('node:fs');
const path = require('node:path');

const log = process.argv[2];
if (!log) { console.error('Uso: node scripts/financeiro/ci/dividirLog.js <arquivo .log da execução --todos>'); process.exit(2); }
const relatorio = JSON.parse(fs.readFileSync(log.replace(/\.log$/, '.json'), 'utf8'));
const linhas = fs.readFileSync(log, 'utf8').split('\n');
const base = log.replace(/\.log$/, '');
for (const e of relatorio.estagios) {
  const ini = linhas.findIndex((l) => l === `# estágio ${e.numero}: ${e.nome}`);
  const fim = linhas.findIndex((l) => l.startsWith(`# estágio ${e.numero}: ${e.nome} => `));
  const trecho = ini >= 0 && fim >= ini ? linhas.slice(ini, fim + 1) : [`# estágio ${e.numero}: ${e.nome} => ${e.status} (não rodou nesta execução)`];
  fs.writeFileSync(`${base}-${e.numero}.log`, `${trecho.join('\n')}\n`);
  fs.writeFileSync(`${base}-${e.numero}.json`, `${JSON.stringify({ commit: relatorio.commit, execucao: { inicio: relatorio.inicio, fim: relatorio.fim, modo: relatorio.modo, arquivo: path.basename(log) }, estagio: e }, null, 2)}\n`);
}
console.log(`${relatorio.estagios.length} estágio(s) separados em ${path.basename(base)}-<N>.log/.json (resultado da execução: ${relatorio.resultado}).`);
