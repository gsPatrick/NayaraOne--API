'use strict';

// Marco 9, M9-D237 — confirmação por status final assinado, valor conferido em centavos, webhook idempotente pela caixa de entrada e recusa do banco.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d237Env');
const financeController = require('../../../src/modules/finance/presentation/http/finance.controller');
const { resolveError } = require('../../../src/features/integrations/errors');
const { transitionDispatch } = require('../../../src/features/integrations/dispatch');

const { sequelize, withRollbackTenantTransaction, uniqueSuffix } = env;
let tenant;
before(async () => { tenant = await env.carregar(); });
after(async () => { await sequelize.close(); });

const SEGREDO = 'segredo-webhook-d237';
const webhook = (t, corpo) => financeController.processBankPaymentWebhook(env.assinado(SEGREDO, corpo), t);
const evento = () => `evt-d237-${uniqueSuffix()}`;

test('banco_webhook_paid_confirma', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await env.definirSegredoWebhook(t, SEGREDO);
    const { entry, intent } = await env.intencaoEnviada(t, { amount: 1250 });
    const r = await webhook(t, { externalSubmissionId: intent.externalSubmissionId, status: 'paid', amount: '1250.00', externalEventId: evento() });
    assert.deepEqual([r.processed, r.mismatch], [true, undefined]);
    await intent.reload({ transaction: t });
    assert.equal(intent.status, 'CONFIRMED');
    assert.equal((await entry.reload({ transaction: t })).status, 'SETTLED');
    const [d] = await env.envios(t, intent.id);
    assert.equal(d.status, 'CONFIRMED', 'o status final assinado confirma o envio, sem exigir o extrato');
    assert.ok(d.confirmed_at);
    assert.equal(d.external_status.toUpperCase(), 'PAID');
  });
});

test('banco_valor_divergente_nao_confirma', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await env.definirSegredoWebhook(t, SEGREDO);
    const { entry, intent } = await env.intencaoEnviada(t, { amount: 1250 });
    const r = await webhook(t, { externalSubmissionId: intent.externalSubmissionId, status: 'paid', amount: '1205.00', externalEventId: evento() });
    assert.deepEqual([r.processed, r.mismatch, r.code], [false, true, 'INTEGRATION_BANK_AMOUNT_MISMATCH']);
    await intent.reload({ transaction: t });
    assert.equal(intent.status, 'EXECUTING', 'o valor diferente não confirma');
    assert.equal((await entry.reload({ transaction: t })).status, 'PENDING');
    const [d] = await env.envios(t, intent.id);
    assert.equal(d.status, 'SUBMITTED', 'o envio permanece onde estava');
    const [erro] = await env.erros(t, 'INTEGRATION_BANK_AMOUNT_MISMATCH');
    assert.deepEqual([erro.severity, erro.status], ['CRITICAL', 'OPEN']);
    assert.match(erro.message, /valor confirmado pelo banco difere do valor aprovado/i);
    // revisão humana: a pessoa decide que o pagamento não vale e o envio vai a FAILED
    await resolveError(erro.id, { note: 'Banco pagou valor errado; devolução pedida.', decision: 'REJECT_PAYMENT' }, env.ctxDe(), t);
    assert.equal((await env.envios(t, intent.id))[0].status, 'FAILED');
  });
});

test('banco_webhook_duplicado_ignorado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await env.definirSegredoWebhook(t, SEGREDO);
    const { entry, intent } = await env.intencaoEnviada(t);
    const corpo = { externalSubmissionId: intent.externalSubmissionId, status: 'paid', amount: '150.75', externalEventId: evento() };
    assert.equal((await webhook(t, corpo)).processed, true);
    const segundo = await webhook(t, corpo);
    assert.deepEqual([segundo.processed, segundo.reason], [false, 'duplicate_event']);
    const caixa = await env.linhas(t, 'SELECT 1 FROM integration.webhook_inbox WHERE company_id = :c AND external_event_id = :e', { c: tenant.companyId, e: corpo.externalEventId });
    assert.equal(caixa.length, 1, 'UNIQUE(fornecedor, id do evento) na caixa de entrada');
    assert.equal((await entry.reload({ transaction: t })).status, 'SETTLED');
  });
});

test('banco_pagamento_recusado_vira_failed', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await env.definirSegredoWebhook(t, SEGREDO);
    const { entry, intent } = await env.intencaoEnviada(t);
    await webhook(t, { externalSubmissionId: intent.externalSubmissionId, status: 'REJECTED', externalEventId: evento() });
    await intent.reload({ transaction: t });
    assert.equal(intent.status, 'FAILED');
    assert.equal((await entry.reload({ transaction: t })).status, 'PENDING');
    const [d] = await env.envios(t, intent.id);
    assert.equal(d.status, 'FAILED');
    assert.match(d.last_error_code, /REJECTED/);
  });
});

test('banco_confirmed_por_status_sem_exigir_extrato_e_mismatch_mantem_dispatch', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    // 1. a consulta de status (STATUS_QUERY) confirma sem nenhuma entrada de extrato
    const a = await env.intencaoEnviada(t);
    const r = await env.bankPayments.reconcilePaymentIntent(a.intent.id, { userId: null }, t);
    assert.equal(r.intent.status, 'CONFIRMED');
    assert.equal((await env.envios(t, a.intent.id))[0].status, 'CONFIRMED');
    assert.equal(r.intent.reconciledAt || null, null, 'sem extrato o pagamento confirmado ainda não está conciliado');
    // 2. envio incerto (UNKNOWN) + valor divergente: o envio continua UNKNOWN e a resolução humana leva a FAILED
    const b = await env.intencaoEnviada(t, { amount: 80 });
    const [d] = await env.envios(t, b.intent.id);
    await sequelize.query("UPDATE integration.dispatches SET status = 'UNKNOWN', unknown_since = now() WHERE id = :id", { replacements: { id: d.id }, transaction: t });
    const m = await env.paymentService.confirmBankPayment(b.intent.externalSubmissionId, 'PAID', t, { amount: '8.00', source: 'WEBHOOK_SIGNED' });
    assert.equal(m.status, 'EXECUTING');
    assert.equal((await env.envios(t, b.intent.id))[0].status, 'UNKNOWN');
    const [erro] = await env.erros(t, 'INTEGRATION_BANK_AMOUNT_MISMATCH');
    await resolveError(erro.id, { note: 'Pagamento não vale.', decision: 'REJECT_PAYMENT' }, env.ctxDe(), t);
    assert.equal((await env.envios(t, b.intent.id))[0].status, 'FAILED', 'UNKNOWN -> FAILED pela resolução humana');
    assert.equal(typeof transitionDispatch, 'function');
  });
});
