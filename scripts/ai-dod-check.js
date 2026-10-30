#!/usr/bin/env node
'use strict';

/**
 * ai-dod-check (M9-D047, livro seção 16 e Guia §18/§19): o Definition of Done da NAY como portão objetivo. Confere os 16 itens da matriz docs/ai/dod-ia-nay.json
 * (teste existente e verde na execução offline, demanda verificada) e imprime a autochecagem de quatro perguntas, calculada por fatos. Item sem prova: linha
 * "AI_DOD_ITEM_MISSING DoD item N sem prova" na saída de erro e exit 1. Somente leitura: sem banco, sem MFA, sem segredo.
 * Uso: node scripts/ai-dod-check.js [--demandas <pasta>] [--raiz <pasta da API>] [--matriz <arquivo>]
 */
const path = require('node:path');
const { carregar, ARQUIVO } = require('./ai-dod/lib/matriz');
const { ambienteReal } = require('./ai-dod/lib/ambiente');
const { executar } = require('./ai-dod/lib/executar');
const { limpar } = require('./int-autocheck/lib/saida');

const argv = process.argv.slice(2);
const valor = (nome) => { const i = argv.indexOf(nome); return i >= 0 ? argv[i + 1] : undefined; };

try {
  const matriz = carregar(valor('--matriz') ? path.resolve(valor('--matriz')) : ARQUIVO);
  const demandas = valor('--demandas');
  const raiz = valor('--raiz');
  const r = executar(matriz, ambienteReal({ demandas: demandas && path.resolve(demandas), raiz: raiz && path.resolve(raiz), relatorioAdversarial: matriz.relatorioAdversarial }));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.code);
} catch (e) {
  process.stderr.write(`DoD da NAY recusado: ${limpar(e.message)}\n`);
  process.exit(2);
}
