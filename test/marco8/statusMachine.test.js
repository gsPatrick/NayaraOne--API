'use strict';

// Marco 8 — máquina de status do caderno.
// "DRAFT → DOCUMENTS_PENDING → READY_TO_SUBMIT → SUBMITTED → UNDER_ANALYSIS →
// PENDING_CUSTOMER/PENDING_PROPERTY → APPROVED/REJECTED → CONTRACTING → COMPLETED ou CANCELED."
// "status fora de ordem não regride."

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RANK, shouldApplyTransition } = require('../../src/features/correspondent/statusMachine');

const ESTADOS = [
  'DRAFT',
  'DOCUMENTS_PENDING',
  'READY_TO_SUBMIT',
  'SUBMITTED',
  'UNDER_ANALYSIS',
  'PENDING_CUSTOMER',
  'PENDING_PROPERTY',
  'APPROVED',
  'REJECTED',
  'CONTRACTING',
  'COMPLETED',
  'CANCELED',
];

test('M8-STATUS-01: o caderno tem estes 12 estados e nenhum a mais', () => {
  assert.deepEqual(Object.keys(RANK).sort(), [...ESTADOS].sort());
  for (const estado of ESTADOS) {
    assert.equal(typeof RANK[estado], 'number', estado);
  }
});

test('M8-STATUS-02: a cadeia avança na ordem do caderno', () => {
  const cadeia = ['DRAFT', 'DOCUMENTS_PENDING', 'READY_TO_SUBMIT', 'SUBMITTED', 'UNDER_ANALYSIS', 'APPROVED', 'CONTRACTING', 'COMPLETED'];
  for (let i = 0; i < cadeia.length - 1; i += 1) {
    assert.equal(shouldApplyTransition(cadeia[i], cadeia[i + 1]), true, `${cadeia[i]} → ${cadeia[i + 1]}`);
  }
  assert.equal(shouldApplyTransition('CONTRACTING', 'CANCELED'), true);
  assert.equal(shouldApplyTransition('UNDER_ANALYSIS', 'REJECTED'), true);
});

test('M8-STATUS-03: PENDING_CUSTOMER e PENDING_PROPERTY são ramos do mesmo estágio, não regressão', () => {
  assert.equal(shouldApplyTransition('UNDER_ANALYSIS', 'PENDING_CUSTOMER'), true);
  assert.equal(shouldApplyTransition('UNDER_ANALYSIS', 'PENDING_PROPERTY'), true);
  assert.equal(shouldApplyTransition('PENDING_CUSTOMER', 'PENDING_PROPERTY'), true);
  assert.equal(shouldApplyTransition('PENDING_PROPERTY', 'APPROVED'), true);
});

test('M8-STATUS-04: status fora de ordem não regride o caso', () => {
  assert.equal(shouldApplyTransition('APPROVED', 'UNDER_ANALYSIS'), false);
  assert.equal(shouldApplyTransition('SUBMITTED', 'DRAFT'), false);
  assert.equal(shouldApplyTransition('COMPLETED', 'CONTRACTING'), false);
  assert.equal(shouldApplyTransition('REJECTED', 'DOCUMENTS_PENDING'), false);
});

test('M8-STATUS-05: decisão terminal não vira o irmão oposto', () => {
  assert.equal(shouldApplyTransition('APPROVED', 'REJECTED'), false);
  assert.equal(shouldApplyTransition('REJECTED', 'APPROVED'), false);
  assert.equal(shouldApplyTransition('COMPLETED', 'CANCELED'), false);
  assert.equal(shouldApplyTransition('CANCELED', 'COMPLETED'), false);
});

test('M8-STATUS-06: status desconhecido não é aplicado', () => {
  assert.equal(shouldApplyTransition('SUBMITTED', 'FORA_DO_CADERNO'), false);
  assert.equal(shouldApplyTransition('SUBMITTED', ''), false);
});
