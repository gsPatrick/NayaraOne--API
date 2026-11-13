'use strict';

// Marco 9, M9-D237 — o pagamento bancário nasce em integration.dispatches: HTTP 200/202 só envia (SUBMITTED), timeout nunca duplica, conteúdo minimizado.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d237Env');
const { hashPayload } = require('../../../src/features/integrations/dispatch');
const { SandboxBankAdapter } = require('../../../src/modules/finance/infrastructure/bank/providers/sandbox.provider');

const { sequelize, withRollbackTenantTransaction } = env;
let tenant;
before(async () => { tenant = await env.carregar(); });
after(async () => { await sequelize.close(); });

/** Troca o submitPayment do sandbox por um que anota o pedido e segue para o original (ou para `comportamento`). */
function espiar(comportamento) {
  const original = SandboxBankAdapter.prototype.submitPayment;
  const chamadas = [];
  SandboxBankAdapter.prototype.submitPayment = async function espiado(req) {
    chamadas.push(req);
    return comportamento ? comportamento.call(this, req, original, chamadas.length) : original.call(this, req);
  };
  return { chamadas, restaurar: () => { SandboxBankAdapter.prototype.submitPayment = original; } };
}
const timeout = () => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });

test('banco_http_200_nao_confirma_pagamento', async () => {
  const espiao = espiar();
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const { entry, intent } = await env.intencaoEnviada(t);
      assert.equal(intent.status, 'SUBMITTED', 'a ordem aceita pelo banco é só SUBMITTED');
      assert.equal((await entry.reload({ transaction: t })).status, 'PENDING', 'o lançamento não é liquidado por uma resposta de envio');
      const [d, ...outros] = await env.envios(t, intent.id);
      assert.equal(outros.length, 0);
      assert.deepEqual([d.operation, d.criticality_op, d.confirmation_mode, d.status, d.provider_code], ['submitPayment', 'DANGEROUS', 'ON_STATUS', 'SUBMITTED', 'bank-sandbox']);
      assert.equal(d.confirmed_at, null);
      assert.equal(d.idempotency_key, intent.idempotencyKey);
      assert.equal(d.external_resource_id, intent.externalSubmissionId);
      assert.equal(espiao.chamadas.length, 1);
      assert.equal(espiao.chamadas[0].idempotencyKey, intent.idempotencyKey, 'o banco recebe a chave na interface original');
    });
  } finally { espiao.restaurar(); }
});

test('m9_d237_dispatch_minimizado_linha_real', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { intent, conta } = await env.intencaoEnviada(t, { amount: 1250 });
    const [d] = await env.envios(t, intent.id);
    assert.equal(d.purpose, 'PAYMENT', 'a finalidade fica gravada');
    const s = d.payload_snapshot;
    assert.equal(s.amount, '1250.00', 'valor como texto decimal com 2 casas, nunca número de ponto flutuante');
    assert.equal(s.currency, 'BRL');
    assert.equal(s.kind, 'PIX');
    assert.equal(s.payee.pixKey, conta.pixKey);
    assert.equal(d.payload_hash, hashPayload(s), 'o hash é do conteúdo minimizado');
    ['personId', 'snapshotJson', 'bankAccountId', 'financialEntryId', 'providerPayload'].forEach((k) => assert.equal(k in s, false, `${k} não sai para o banco`));
    assert.equal(JSON.stringify(s).includes(intent.id), false);
  });
});

test('banco_timeout_nao_duplica_pagamento', async () => {
  // O banco aceita a ordem, mas a resposta se perde: o envio fica UNKNOWN e a consulta pela chave acha o pagamento, sem segunda ordem.
  const perdida = espiar(async function aceitaMasPerde(req, original) { await original.call(this, req); throw timeout(); });
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const { intent: incerta } = await env.intencaoEnviada(t);
      assert.equal(incerta.status, 'SUBMITTING');
      assert.equal(incerta.externalStatus, 'UNCERTAIN');
      const [d] = await env.envios(t, incerta.id);
      assert.equal(d.status, 'UNKNOWN', 'timeout depois do envio: incerto, nunca reenviado às cegas');
      const r = await env.bankPayments.reconcilePaymentIntent(incerta.id, { userId: null }, t);
      assert.ok(r.intent.externalSubmissionId, 'a consulta pela chave achou o pagamento do banco e trouxe o id externo');
      assert.equal(r.intent.externalSubmissionId, `sandbox-${incerta.idempotencyKey}`);
      assert.equal(perdida.chamadas.length, 1, 'a reconciliação consulta; não envia de novo');
      assert.equal((await env.envios(t, incerta.id)).length, 1);
    });
  } finally { perdida.restaurar(); }
  // Quando o pedido nem chegou ao banco (consulta afirma que não existe), a repetição só sai com a MESMA chave.
  const naoChegou = espiar(async function naoChega(req, original, n) { if (n === 1) throw timeout(); return original.call(this, req); });
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const { intent } = await env.intencaoEnviada(t);
      assert.equal(intent.status, 'SUBMITTING');
      const r = await env.bankPayments.reconcilePaymentIntent(intent.id, { userId: null }, t);
      assert.ok(r.intent.externalSubmissionId, 'a ordem saiu depois que o banco afirmou que não a conhecia');
      assert.equal(naoChegou.chamadas.length, 2);
      assert.equal(naoChegou.chamadas[0].idempotencyKey, naoChegou.chamadas[1].idempotencyKey, 'mesma chave de idempotência nas duas ordens');
      assert.equal((await env.envios(t, intent.id)).length, 1, 'um único envio');
    });
  } finally { naoChegou.restaurar(); }
});

test('banco_circuito_aberto_reagenda_sem_enviar', async () => {
  const espiao = espiar();
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const { ensureBankConnection } = require('../../../src/modules/finance/application/services/bank-hub');
      const { updateCircuitState } = require('../../../src/features/integrations/health');
      const conexao = await ensureBankConnection(env.ctxDe(), 'sandbox', t);
      await updateCircuitState(conexao.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(), circuitCooldownS: 600 }, t);
      const { intent } = await env.intencaoEnviada(t);
      assert.equal(intent.status, 'SUBMITTING', 'fornecedor fora: a ordem espera, não é dada como enviada');
      assert.equal(espiao.chamadas.length, 0, 'o banco fora não é chamado');
      const [d] = await env.envios(t, intent.id);
      assert.ok(['PENDING', 'RETRY_WAIT'].includes(d.status), `o envio fica reagendado (${d.status})`);
      assert.match(intent.failureReason, /reagendad/i);
    });
  } finally { espiao.restaurar(); }
});
