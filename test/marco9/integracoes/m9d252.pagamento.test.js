'use strict';

// Marco 9, M9-D252 — teste adversarial 13 do livro (seção 19): pagamento de R$ 1.250,00 com timeout não duplica; depois da reconciliação há UMA ordem no banco sandbox e UM envio no registro de integração.
// Dois cenários de timeout: o banco aceitou e a resposta se perdeu; o pedido nem chegou e a repetição sai com a MESMA chave. Cada teste termina em rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d237Env');
const { SandboxBankAdapter } = require('../../../src/modules/finance/infrastructure/bank/providers/sandbox.provider');

const { sequelize, withRollbackTenantTransaction } = env;
before(async () => { await env.carregar(); });
after(async () => { await sequelize.close(); });

const timeout = () => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });

/** Troca o submitPayment do sandbox: `quando(n)` decide, por chamada, se o pedido chega ao banco e se a resposta se perde. Conta as ordens que o banco de fato recebeu. */
function bancoComTimeout(quando) {
  const original = SandboxBankAdapter.prototype.submitPayment;
  const chamadas = []; const recebidas = [];
  SandboxBankAdapter.prototype.submitPayment = async function submitPayment(req) {
    chamadas.push(req);
    const { chega, perdeResposta } = quando(chamadas.length);
    if (chega) { recebidas.push(req); await original.call(this, req); }
    if (perdeResposta) throw timeout();
    return { externalId: `sandbox-${req.idempotencyKey}`, status: 'PENDING_EXTERNAL' };
  };
  return { chamadas, recebidas, restaurar: () => { SandboxBankAdapter.prototype.submitPayment = original; } };
}

test('adv_pagamento_timeout_nao_duplica', async () => {
  // Cenário 1: o banco aceita a ordem e a resposta se perde.
  const perdida = bancoComTimeout(() => ({ chega: true, perdeResposta: true }));
  try {
    await withRollbackTenantTransaction(env.tenant, async (t) => {
      const { intent } = await env.intencaoEnviada(t, { amount: 1250 });
      assert.equal(intent.status, 'SUBMITTING');
      assert.equal(intent.externalStatus, 'UNCERTAIN');
      let envios = await env.envios(t, intent.id);
      assert.equal(envios.length, 1);
      assert.equal(envios[0].status, 'UNKNOWN', 'timeout: incerto, nunca reenviado às cegas');
      assert.equal(envios[0].payload_snapshot.amount, '1250.00');
      const r = await env.bankPayments.reconcilePaymentIntent(intent.id, { userId: null }, t);
      assert.equal(r.intent.externalSubmissionId, `sandbox-${intent.idempotencyKey}`, 'a consulta pela chave achou a ordem');
      envios = await env.envios(t, intent.id);
      assert.equal(envios.length, 1, 'um único envio depois da reconciliação');
      assert.equal(perdida.chamadas.length, 1, 'a reconciliação consulta; não envia de novo');
      assert.equal(perdida.recebidas.length, 1, 'uma única ordem no banco sandbox');
      assert.equal(new SandboxBankAdapter().findByIdempotencyKey(intent.idempotencyKey).found, true);
    });
  } finally { perdida.restaurar(); }

  // Cenário 2: o pedido nem chegou ao banco; a repetição sai com a MESMA chave e ainda assim há uma só ordem.
  const naoChegou = bancoComTimeout((n) => (n === 1 ? { chega: false, perdeResposta: true } : { chega: true, perdeResposta: false }));
  try {
    await withRollbackTenantTransaction(env.tenant, async (t) => {
      const { intent } = await env.intencaoEnviada(t, { amount: 1250 });
      assert.equal(intent.status, 'SUBMITTING');
      const r = await env.bankPayments.reconcilePaymentIntent(intent.id, { userId: null }, t);
      assert.ok(r.intent.externalSubmissionId, 'a ordem saiu depois que o banco afirmou não conhecê-la');
      assert.equal(naoChegou.chamadas.length, 2);
      assert.equal(naoChegou.chamadas[0].idempotencyKey, naoChegou.chamadas[1].idempotencyKey, 'mesma chave nas duas tentativas');
      assert.equal(naoChegou.recebidas.length, 1, 'uma única ordem no banco sandbox');
      assert.equal((await env.envios(t, intent.id)).length, 1, 'um único envio');
    });
  } finally { naoChegou.restaurar(); }
});
