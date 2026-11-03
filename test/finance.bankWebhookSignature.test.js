'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const financeController = require('../src/features/finance/finance.controller');

// Bug real corrigido nesta auditoria (rodada 38, 2026-10-05): bankPaymentPublicWebhook nunca
// validava assinatura nenhuma — mesma falha de segurança corrigida no webhook de seguro (R37).
// Qualquer requisição que conhecesse um externalSubmissionId válido conseguia forjar a
// confirmação de um pagamento bancário real e liquidar o lançamento financeiro correspondente.
test('bank webhook: verifyBankWebhookSignature aceita HMAC válido e rejeita ausente/errado/sem secret (timing-safe)', () => {
  const secret = 'bank-webhook-secret-abc';
  const rawBody = Buffer.from(JSON.stringify({ externalSubmissionId: 'sandbox-payment-1', status: 'CONFIRMED' }));
  const validHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  assert.equal(
    financeController.verifyBankWebhookSignature(rawBody, { 'x-webhook-signature': `sha256=${validHex}` }, secret),
    true
  );
  assert.equal(
    financeController.verifyBankWebhookSignature(rawBody, { 'x-webhook-signature': `sha256=${'a'.repeat(64)}` }, secret),
    false,
    'assinatura incorreta precisa ser rejeitada'
  );
  assert.equal(
    financeController.verifyBankWebhookSignature(rawBody, {}, secret),
    false,
    'header ausente precisa ser rejeitado'
  );
  assert.equal(
    financeController.verifyBankWebhookSignature(rawBody, { 'x-webhook-signature': `sha256=${validHex}` }, null),
    false,
    'sem secret configurado nunca pode validar (fail-closed)'
  );
  assert.equal(
    financeController.verifyBankWebhookSignature(Buffer.alloc(0), { 'x-webhook-signature': `sha256=${validHex}` }, secret),
    false,
    'corpo vazio precisa ser rejeitado'
  );

  const tamperedBody = Buffer.from(JSON.stringify({ externalSubmissionId: 'sandbox-payment-1', status: 'FAILED' }));
  assert.equal(
    financeController.verifyBankWebhookSignature(tamperedBody, { 'x-webhook-signature': `sha256=${validHex}` }, secret),
    false,
    'adulterar o status após assinar precisa invalidar a assinatura'
  );
});
