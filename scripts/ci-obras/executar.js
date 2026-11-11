#!/usr/bin/env node
'use strict';
/**
 * Esteira de CI/CD de Obras (Guia do Marcelo, Marco 6, §13): roda as 17 etapas na ordem do livro e PARA na primeira vermelha
 * (as seguintes ficam NAO_RODOU). Sem --release, a etapa LAB sai NAO_APLICAVEL (só em tag obr-release-*, decisão DI-M6Q-1).
 * Grava o relatório (nome, status, duração, commit) em --relatorio. Executor comum: scripts/lib/esteiraLivro.js.
 *
 *   node scripts/ci-obras/executar.js [--release] [--relatorio arquivo.json] [--de N] [--ate N]
 */
const path = require('node:path');
const { ETAPAS, validar } = require('./etapas');
const { executarEsteira } = require('../lib/esteiraLivro');

const ROOT = path.resolve(__dirname, '..', '..');

process.exit(executarEsteira({
  esteira: 'obras (Guia M6 §13)',
  etapas: ETAPAS,
  validar,
  raiz: ROOT,
  relatorioPadrao: path.join(ROOT, 'docs', 'evidencias', 'ci', 'esteira-obras.json'),
  codigoFalha: 'CONSTRUCTION_CI_STAGE_FAILED',
  motivoRelease: 'etapa de release: só em tag obr-release-* (ambiente LAB do Patrick, DI-M6Q-1)',
  portas: {
    portaDrill: { env: 'OBR_CI_PORTA_DRILL', base: 41500, faixa: 1500 },
    portaHttp: { env: 'OBR_CI_PORTA_HTTP', base: 45000, faixa: 1000 },
  },
}));
