'use strict';

// O script de simulação do retorno do sinistro assina exatamente como o webhook público valida.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assinar, idExternoDoSandbox, HEADER } = require('../scripts/simularRetornoSinistro');
const { verifyInsuranceWebhookSignature } = require('../src/features/procurement/insurance.controller');

test('SIM-SINISTRO-01: assinatura do script é aceita pelo webhook; errada e vazia são recusadas', () => {
  const corpo = Buffer.from(JSON.stringify({ externalSubmissionId: idExternoDoSandbox('11111111-1111-1111-1111-111111111111'), status: 'SETTLED', settledAmount: 1500 }));
  const headers = { [HEADER]: assinar('segredo-de-teste', corpo) };
  assert.equal(verifyInsuranceWebhookSignature(corpo, headers, 'segredo-de-teste'), true);
  assert.equal(verifyInsuranceWebhookSignature(corpo, headers, 'outro-segredo'), false);
  assert.equal(verifyInsuranceWebhookSignature(corpo, { [HEADER]: assinar('segredo-de-teste-errado', corpo) }, 'segredo-de-teste'), false);
  assert.equal(verifyInsuranceWebhookSignature(corpo, {}, 'segredo-de-teste'), false);
});

test('SIM-SINISTRO-02: o id externo do sandbox segue a chave de idempotência da submissão', () => {
  assert.equal(idExternoDoSandbox('abc'), 'sandbox-claim-insurance-claim:abc');
});
