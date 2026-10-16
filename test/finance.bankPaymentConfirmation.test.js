'use strict';

// Auditoria complementar Nayara, 14/10/2026 — Seção 4, Marco 4, grupo "Pagamento + confirmação
// bancária (FIN-TS-001/002/018/019)": "Não comprovado — Sandbox sem dinheiro real: timeout,
// falha, resposta incerta, callback válido/duplicado/forjado e criação de ledger só após
// confirmação." O adapter SandboxBankAdapter e o caminho submit->confirm já existiam
// (bankPayments.service.js, adapters/BankAdapter.js) mas sem teste de integração real provando
// o comportamento contra Postgres — só testes de serviço isolado da própria auditoria.
//
// Este teste roda contra o banco real de dev (mesmo padrão de testHelpers.js, RLS ativo via
// nayara_runtime), SEM mock de banco de dados — só o provedor bancário externo é simulado
// (SandboxBankAdapter, que é o próprio fallback padrão de produção quando nenhum provider real
// está configurado — não um mock de teste).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getSeedTenant,
  withRollbackTenantTransaction,
  createTestCostCenter,
  uniqueSuffix,
} = require('./testHelpers');

const { createFinancialEntry } = require('../src/features/finance/financialEntries.service');
const { createPaymentIntent, approvePaymentIntent } = require('../src/features/finance/paymentIntents.service');
const { submitPaymentIntentToBank, confirmBankPayment } = require('../src/features/finance/bankPayments.service');
const { BankAccount, User } = require('../src/models');

async function makeApproverUserId(transaction) {
  const [approver] = await User.findOrCreate({
    where: { email: `homo-qa-bank-approver-${uniqueSuffix()}@nayaraone.dev` },
    defaults: { name: 'HOMO QA — Aprovador de pagamento bancário', passwordHash: 'x', status: 'ACTIVE' },
    transaction,
  });
  return approver.id;
}

async function makeApprovedIntent(tenant, transaction) {
  const costCenter = await createTestCostCenter(tenant, transaction);

  const bankAccount = await BankAccount.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      bankCode: '001',
      agency: '0001',
      accountNumber: `TESTE-${uniqueSuffix()}`,
      pixKey: `pix-teste-${uniqueSuffix()}@nayaraone.dev`,
      status: 'ACTIVE',
    },
    { transaction }
  );

  const entry = await createFinancialEntry(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: 150.75,
      description: `Pagamento de teste ${uniqueSuffix()}`,
      dueAt: new Date(Date.now() + 86400000),
      costCenterId: costCenter.id,
      bankAccountId: bankAccount.id,
    },
    tenant.userId,
    transaction
  );

  const intent = await createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, transaction);
  // approvePaymentIntent só exige ApprovalRequest APPROVED quando a intent foi criada com
  // approvalRequestId; aqui não foi vinculada, então só checa segregação (aprovador != criador).
  const approverUserId = await makeApproverUserId(transaction);
  const approved = await approvePaymentIntent(intent.id, approverUserId, transaction);
  return { entry, intent: approved, bankAccount };
}

test('FIN-TS-001/018: submissão ao banco não liquida o lançamento — só CONFIRMED libera o ledger', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry, intent } = await makeApprovedIntent(tenant, transaction);

    const submitted = await submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, transaction);
    assert.equal(submitted.status, 'SUBMITTED');

    await entry.reload({ transaction });
    assert.equal(entry.status, 'PENDING', 'lançamento não pode ser liquidado só por ter sido submetido ao banco');
  });
});

test('FIN-TS-019: callback CONFIRMED do banco libera o ledger (liquida o lançamento)', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry, intent } = await makeApprovedIntent(tenant, transaction);
    const submitted = await submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, transaction);

    const confirmed = await confirmBankPayment(submitted.externalSubmissionId, 'CONFIRMED', transaction);
    assert.equal(confirmed.status, 'EXECUTED');

    await entry.reload({ transaction });
    assert.equal(entry.status, 'SETTLED');
  });
});

test('FIN-TS-002: callback de falha do banco NÃO liquida o lançamento e marca FAILED', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry, intent } = await makeApprovedIntent(tenant, transaction);
    const submitted = await submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, transaction);

    const failed = await confirmBankPayment(submitted.externalSubmissionId, 'REJECTED', transaction);
    assert.equal(failed.status, 'FAILED');

    await entry.reload({ transaction });
    assert.equal(entry.status, 'PENDING', 'falha do provedor não pode liquidar nem travar o lançamento num estado intermediário');
  });
});

test('Callback duplicado (idempotência): reprocessar CONFIRMED duas vezes não liquida duas vezes', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry, intent } = await makeApprovedIntent(tenant, transaction);
    const submitted = await submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, transaction);

    const first = await confirmBankPayment(submitted.externalSubmissionId, 'CONFIRMED', transaction);
    assert.equal(first.status, 'EXECUTED');

    // Segunda entrega do mesmo webhook (reenvio real de provedor, retry de rede) — não pode
    // liquidar de novo nem lançar erro: confirmBankPayment detecta que já saiu de SUBMITTED e
    // retorna o estado atual sem reprocessar.
    const second = await confirmBankPayment(submitted.externalSubmissionId, 'CONFIRMED', transaction);
    assert.equal(second.status, 'EXECUTED');
    assert.equal(second.id, first.id);

    await entry.reload({ transaction });
    assert.equal(entry.status, 'SETTLED');
  });
});

test('Callback forjado: id de submissão externa inexistente é recusado, não cria nada', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => confirmBankPayment('sandbox-id-que-nunca-existiu', 'CONFIRMED', transaction),
      (err) => err.code === 'FINANCE_BANK_PAYMENT_ROUTING_NOT_FOUND'
    );
  });
});

test('Resposta incerta do provedor (status desconhecido) não é tratada como confirmação — só CONFIRMED libera ledger', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry, intent } = await makeApprovedIntent(tenant, transaction);
    const submitted = await submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, transaction);

    const uncertain = await confirmBankPayment(submitted.externalSubmissionId, 'PROCESSING_UNKNOWN', transaction);
    assert.equal(uncertain.status, 'FAILED', 'qualquer status diferente de CONFIRMED é tratado como não-confirmado, nunca como sucesso silencioso');

    await entry.reload({ transaction });
    assert.equal(entry.status, 'PENDING');
  });
});
