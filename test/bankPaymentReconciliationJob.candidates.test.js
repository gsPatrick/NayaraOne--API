'use strict';

// Achado na execução ao vivo (NODE_ENV=development, onde os jobs agendados rodam): o job de reconciliação bancária
// falhava a cada rodada com "column PaymentIntent.updatedAt does not exist", porque o model renomeia o atributo para `updated_at`.
// A suíte nunca viu isso porque, sob NODE_ENV=test, os jobs agendados não rodam. Este teste executa a consulta de candidatos de verdade.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, createTestCostCenter, uniqueSuffix } = require('./testHelpers');
const { BankAccount } = require('../src/models');
const financialEntriesService = require('../src/modules/finance/application/services/financial-entry.service');
const paymentIntentsService = require('../src/modules/finance/application/services/payment.service');
const { findReconcileCandidates } = require('../src/engines/jobs/bankPaymentReconciliationJob');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function newIntent(t) {
  const cc = await createTestCostCenter(tenant, t);
  const ba = await BankAccount.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `REC-${uniqueSuffix()}`, pixKey: `rec-${uniqueSuffix()}@x.dev`, status: 'ACTIVE' },
    { transaction: t }
  );
  const entry = await financialEntriesService.createFinancialEntry(
    { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 150, description: 'REC-JOB', costCenterId: cc.id, bankAccountId: ba.id, dueAt: new Date(Date.now() + 86400000) },
    tenant.userId,
    t
  );
  return paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
}

// Guia M4 §3 (DEC-056): enviando/enviado ao banco = EXECUTING com a fase em submission_phase; pago = CONFIRMED.
async function setState(t, id, status, phase, minutesAgo) {
  await sequelize.query(
    "UPDATE finance.payment_intents SET status = :status, submission_phase = :phase, updated_at = now() - (:min * interval '1 minute') WHERE id = :id",
    { replacements: { status, phase, min: minutesAgo, id }, transaction: t }
  );
}

test('job de reconciliação bancária: a consulta de candidatos executa e devolve o intent preso (antigo), não o recente', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const preso = await newIntent(t);
    const presoSubmitted = await newIntent(t);
    const recente = await newIntent(t);
    const outroStatus = await newIntent(t);
    await setState(t, preso.id, 'EXECUTING', 'SUBMITTING', 60);
    await setState(t, presoSubmitted.id, 'EXECUTING', 'SUBMITTED', 60);
    await setState(t, recente.id, 'EXECUTING', 'SUBMITTING', 0);
    await setState(t, outroStatus.id, 'CONFIRMED', 'SUBMITTED', 60);

    const candidates = await findReconcileCandidates({ groupId: tenant.groupId, companyId: tenant.companyId }, t);
    const ids = candidates.map((c) => c.id);
    assert.ok(ids.includes(preso.id), 'SUBMITTING antigo precisa ser candidato');
    assert.ok(ids.includes(presoSubmitted.id), 'SUBMITTED antigo precisa ser candidato');
    assert.ok(!ids.includes(recente.id), 'SUBMITTING recente (abaixo da idade mínima) não é candidato');
    assert.ok(!ids.includes(outroStatus.id), 'CONFIRMED (pago) não é candidato');
  });
});
