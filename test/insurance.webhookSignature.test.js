'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const insuranceController = require('../src/features/procurement/insurance.controller');

// Bug real corrigido nesta auditoria (rodada 37, 2026-10-05): insurancePublicWebhook nunca
// validava assinatura nenhuma — qualquer requisição que conhecesse (ou adivinhasse) o
// externalSubmissionId conseguia forjar liquidação de sinistro e lançamento financeiro real.
// Mesmo esquema HMAC-SHA256 já usado pro webhook do Clicksign (timing-safe, header
// "x-webhook-signature", prefixo opcional "sha256=").
test('insurance webhook: verifyInsuranceWebhookSignature aceita HMAC válido e rejeita ausente/errado/sem secret (timing-safe)', () => {
  const secret = 'insurance-webhook-secret-abc';
  const rawBody = Buffer.from(JSON.stringify({ externalSubmissionId: 'sandbox-claim-1', status: 'SETTLED', settledAmount: 1500 }));
  const validHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  assert.equal(
    insuranceController.verifyInsuranceWebhookSignature(rawBody, { 'x-webhook-signature': `sha256=${validHex}` }, secret),
    true
  );
  assert.equal(
    insuranceController.verifyInsuranceWebhookSignature(rawBody, { 'x-webhook-signature': `sha256=${validHex}` }, secret),
    true,
    'aceita também sem o prefixo sha256='
  );
  assert.equal(
    insuranceController.verifyInsuranceWebhookSignature(rawBody, { 'x-webhook-signature': `sha256=${'a'.repeat(64)}` }, secret),
    false,
    'assinatura incorreta precisa ser rejeitada'
  );
  assert.equal(
    insuranceController.verifyInsuranceWebhookSignature(rawBody, {}, secret),
    false,
    'header ausente precisa ser rejeitado'
  );
  assert.equal(
    insuranceController.verifyInsuranceWebhookSignature(rawBody, { 'x-webhook-signature': `sha256=${validHex}` }, null),
    false,
    'sem secret configurado nunca pode validar (fail-closed)'
  );
  assert.equal(
    insuranceController.verifyInsuranceWebhookSignature(Buffer.alloc(0), { 'x-webhook-signature': `sha256=${validHex}` }, secret),
    false,
    'corpo vazio precisa ser rejeitado'
  );

  // Corpo diferente (payload adulterado) com a mesma assinatura do corpo original tem que falhar.
  const tamperedBody = Buffer.from(JSON.stringify({ externalSubmissionId: 'sandbox-claim-1', status: 'SETTLED', settledAmount: 999999 }));
  assert.equal(
    insuranceController.verifyInsuranceWebhookSignature(tamperedBody, { 'x-webhook-signature': `sha256=${validHex}` }, secret),
    false,
    'adulterar o valor (settledAmount) após assinar precisa invalidar a assinatura'
  );
});
