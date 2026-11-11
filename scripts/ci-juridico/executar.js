#!/usr/bin/env node
'use strict';
/**
 * Esteira de CI/CD do jurídico (Guia do Marco 5, §17): roda as 18 etapas na ordem do livro e PARA na
 * primeira vermelha (as seguintes ficam NAO_RODOU). Sem --release, as etapas de release (deploy_DEV,
 * deploy_LAB, production_approval) saem NAO_APLICAVEL. production_approval nunca faz deploy: marca
 * AGUARDANDO_APROVACAO. Grava o relatório (nome, status, duração, commit) em --relatorio.
 * O executor é o comum das esteiras do livro (scripts/lib/esteiraLivro.js); aqui ficam só as etapas e os nomes.
 *
 *   node scripts/ci-juridico/executar.js [--release] [--relatorio arquivo.json] [--de N] [--ate N]
 */
const path = require('node:path');
const { ETAPAS, validar } = require('./etapas');
const { executarEsteira } = require('../lib/esteiraLivro');

const ROOT = path.resolve(__dirname, '..', '..');

process.exit(executarEsteira({
  esteira: 'juridico (Guia M5 §17)',
  etapas: ETAPAS,
  validar,
  raiz: ROOT,
  relatorioPadrao: path.join(ROOT, 'docs', 'evidencias', 'ci', 'esteira-juridico.json'),
  codigoFalha: 'LEGAL_CI_STAGE_FAILED',
  motivoRelease: 'etapa de release: só em tag jur-release-*',
  portas: { portaDrill: { env: 'JUR_CI_PORTA_DRILL', base: 40000, faixa: 1500 } },
}));
