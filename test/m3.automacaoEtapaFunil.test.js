'use strict';

/**
 * DI-M3-FUNIL-1: a ação UPDATE_CRM_STAGE_TAG de uma automação só aceita etapa do funil do livro do Marco 3 §10 (ou um código
 * antigo que vira a etapa do livro); etapa inventada vira pendência na publicação, em vez de falhar quando a automação roda.
 * Função pura, sem banco.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectProblems } = require('../src/features/marketing/automations/definition.validation');

const def = (stage) => ({ actions: [{ actionType: 'UPDATE_CRM_STAGE_TAG', stage }] });
const doEstagio = (problems) => problems.filter((p) => /^actions\[0\]\.stage$/.test(p.field));

test('automação: etapa do livro (ou código antigo) passa; etapa inventada vira pendência com a lista do livro', () => {
  assert.deepEqual(doEstagio(collectProblems(def('PROPOSAL'))), []);
  assert.deepEqual(doEstagio(collectProblems(def('NOVO'))), []);
  const inventada = doEstagio(collectProblems(def('FASE_INVENTADA')));
  assert.equal(inventada.length, 1);
  assert.match(inventada[0].reason, /NURTURE/);
});
