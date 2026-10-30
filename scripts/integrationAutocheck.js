#!/usr/bin/env node
'use strict';

/**
 * integrationAutocheck (M9-D258, Guia de Integrações §15, livro 510 a 514): as quatro perguntas da autochecagem respondidas por fatos verificáveis, nunca por declaração. Imprime cada
 * pergunta com o texto do livro e SIM ou NÃO, com as verificações; sai com 1 se alguma for NÃO (INTEGRATION_DOD_AUTOCHECK_FAILED). É o item 15 do Definition of Done (scripts/integrationDod.js).
 * `--escopo=ia-nay` calcula a primeira pergunta para a IA NAY (M9-D047 só remete a este cálculo). Somente leitura: sem MFA e sem escrita; o estado do portão de produção só é consultado
 * em banco descartável (DISPOSABLE_DB=1); fora dele a condição "homologação por provider" é impressa com todos os providers como pendentes.
 * Uso: node scripts/integrationAutocheck.js [--escopo=integracoes|ia-nay] [--demandas <pasta>] [--raiz <pasta da API>]
 */
const path = require('node:path');
const { compute } = require('./int-autocheck/lib/compute');
const { renderizar } = require('./int-autocheck/lib/saida');

const argv = process.argv.slice(2);
const valor = (nome) => {
  const colado = argv.find((a) => a.startsWith(`${nome}=`));
  if (colado) return colado.slice(nome.length + 1);
  const i = argv.indexOf(nome);
  return i >= 0 ? argv[i + 1] : undefined;
};

(async () => {
  const { ambienteReal } = require('./int-autocheck/lib/ambiente');
  const { consultarPortao } = require('./int-autocheck/lib/ambientePortao');
  const demandas = valor('--demandas');
  const raiz = valor('--raiz');
  const base = raiz ? path.resolve(raiz) : path.resolve(__dirname, '..');
  const escopo = valor('--escopo') || 'integracoes';
  const portao = escopo === 'integracoes' ? await consultarPortao(base) : undefined;
  const ambiente = ambienteReal({ demandas: demandas && path.resolve(demandas), raiz: base, portao });
  const r = renderizar(compute({ escopo, ambiente }));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.code);
})().catch((e) => {
  process.stderr.write(`autochecagem recusada: ${require('./int-autocheck/lib/saida').limpar(e.message)}\n`);
  process.exit(2);
});
