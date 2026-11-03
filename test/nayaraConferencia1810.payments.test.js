'use strict';

/**
 * Revisão independente da conferência Nayara 18/10/2026 — Pagamentos, baixa e caução
 * (Maturacao/FRENTES_PENDENTES_MARCOS4_5.md, seção 1): A1-A4, B1-B6, D1-D4, E1.
 * Banco real, RLS ativo. Os testes de concorrência (B3, D4) e do webhook (B5) precisam de
 * transações commitadas; usam dados próprios, identificados por "PAY1810".
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  sequelize,
  getSeedTenant,
  withRollbackTenantTransaction,
  uniqueSuffix,
  createTestCostCenter,
  createTestResultCenter,
  approveFinancialEntryForSettlement,
  createManualSettlementEvidence,
  prepareManualSettlement,
} = require('./testHelpers');
const { User, BankAccount, Contract, Person, ContractParty, FinancialEntry, PaymentIntent, AnomalyCase, ApprovalRequest, OutboxEvent } = require('../src/models');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const paymentIntentsService = require('../src/features/finance/paymentIntents.service');
const bankPaymentsService = require('../src/features/finance/bankPayments.service');
const approvalsService = require('../src/features/finance/approvals.service');
const filesService = require('../src/features/files/files.service');
const { resolveBankAdapter, setBankAdapterOverrideForTests } = require('../src/features/finance/adapters/resolveBankAdapter');
const { SantanderBankAdapter } = require('../src/features/finance/adapters/BankAdapter');

let tenant;
let approver;

before(async () => {
  tenant = await getSeedTenant();
  [approver] = await User.findOrCreate({
    where: { email: 'homo-qa-pay1810-approver@nayaraone.dev' },
    defaults: { name: 'HOMO QA — Aprovador PAY1810', passwordHash: 'x', status: 'ACTIVE' },
  });
});

after(async () => {
  setBankAdapterOverrideForTests(null);
  await sequelize.close();
});

const W = (fields) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields });

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `esperado ${code}, veio ${err.code}: ${err.message}`);
    return true;
  });
}

async function bank(t) {
  return BankAccount.create(
    W({ bankCode: '001', agency: '0001', accountNumber: `PAY-${uniqueSuffix()}`, pixKey: `pay-${uniqueSuffix()}@x.dev`, status: 'ACTIVE' }),
    { transaction: t }
  );
}

async function payable(t, { withBank = true, amount = 300 } = {}) {
  const cc = await createTestCostCenter(tenant, t);
  const ba = withBank ? await bank(t) : null;
  return financialEntriesService.createFinancialEntry(
    W({ entryType: 'DEBIT', nature: 'PAYABLE', amount, description: 'PAY1810', costCenterId: cc.id, bankAccountId: ba ? ba.id : undefined, dueAt: new Date(Date.now() + 86400000) }),
    tenant.userId,
    t
  );
}

async function submittedIntent(t, entry) {
  const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
  await paymentIntentsService.approvePaymentIntent(intent.id, approver.id, t);
  return bankPaymentsService.submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, t);
}

async function lease(t, extraRoles = []) {
  const s = uniqueSuffix();
  const contract = await Contract.create(
    W({ contractType: 'LEASE', contractNumber: `PAY1810-${s}`, status: 'ACTIVE', createdBy: tenant.userId, updatedBy: tenant.userId }),
    { transaction: t }
  );
  const holder = await Person.create(W({ personType: 'PF', legalName: `PAY1810 ${s}`, createdBy: tenant.userId, updatedBy: tenant.userId }), { transaction: t });
  await ContractParty.create(W({ contractId: contract.id, personId: holder.id, partyRole: 'TENANT' }), { transaction: t });
  const others = {};
  for (const role of extraRoles) {
    const p = await Person.create(W({ personType: 'PF', legalName: `PAY1810 ${role} ${s}`, createdBy: tenant.userId, updatedBy: tenant.userId }), { transaction: t });
    await ContractParty.create(W({ contractId: contract.id, personId: p.id, partyRole: role }), { transaction: t });
    others[role] = p;
  }
  return { contract, holder, others };
}

async function deposit(t, { contract, holder, amount = 1000, settle = true }) {
  const rc = await createTestResultCenter(tenant, t);
  const d = await financialEntriesService.createFinancialEntry(
    W({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount, description: 'PAY1810 caução', resultCenterId: rc.id, contractId: contract.id, isThirdPartyFunds: true, thirdPartyReference: 'Caução', thirdPartyHolderPersonId: holder.id }),
    tenant.userId,
    t
  );
  if (settle) await financialEntriesService.settleFinancialEntry(d.id, tenant.userId, t);
  return d;
}

async function release(t, fields) {
  const cc = await createTestCostCenter(tenant, t);
  return financialEntriesService.createFinancialEntry(
    W({ entryType: 'DEBIT', nature: 'PAYABLE', description: 'PAY1810 devolução', costCenterId: cc.id, isThirdPartyFunds: true, thirdPartyReference: 'Devolução', ...fields }),
    tenant.userId,
    t
  );
}

async function anomalies(t, relatedEntityId, caseType) {
  return AnomalyCase.findAll({ where: { relatedEntityId, caseType }, transaction: t });
}

// ---------------------------------------------------------------------------------------------
// A1 — remover conta / PAYABLE sem conta
// ---------------------------------------------------------------------------------------------

test('A1: a conta bancária de um PAYABLE não pode ser removida (era o atalho para liquidar sem controle)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await payable(t);
    await expectCode(financialEntriesService.updateFinancialEntry(entry.id, { bankAccountId: null }, tenant.userId, t), 'FINANCE_ENTRY_BANK_ACCOUNT_REMOVAL_FORBIDDEN');
  });
});

test('A1: PAYABLE SEM conta não é mais liquidado direto — exige aprovação e comprovante; com eles vira MANUAL_WITH_EVIDENCE', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await payable(t, { withBank: false });
    await expectCode(financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, t), 'FINANCE_ENTRY_PAYABLE_REQUIRES_PAYMENT_INTENT_APPROVAL');
    await approveFinancialEntryForSettlement(tenant, entry.id, tenant.userId, t);
    await expectCode(financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, t), 'FINANCE_ENTRY_BANK_SETTLEMENT_REQUIRES_CONFIRMATION');

    const other = await payable(t, { withBank: false });
    const manualSettlement = await prepareManualSettlement(tenant, other.id, tenant.userId, t);
    const settled = await financialEntriesService.settleFinancialEntry(other.id, tenant.userId, t, { manualSettlement });
    assert.equal(settled.status, 'SETTLED');
    assert.equal(settled.settlementMethod, 'MANUAL_WITH_EVIDENCE');
  });
});

// ---------------------------------------------------------------------------------------------
// A2 — intenção aberta / confirmação de lançamento já liquidado
// ---------------------------------------------------------------------------------------------

test('A2: baixa manual com intenção SUBMITTED no banco é recusada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await payable(t);
    const intent = await submittedIntent(t, entry);
    assert.equal(intent.status, 'SUBMITTED');
    const manualSettlement = await prepareManualSettlement(tenant, entry.id, tenant.userId, t);
    await expectCode(
      financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, t, { manualSettlement }),
      'FINANCE_ENTRY_HAS_OPEN_PAYMENT_INTENT'
    );
    await expectCode(
      financialEntriesService.settleFinancialEntryPartial(entry.id, 10, tenant.userId, t, { manualSettlement }),
      'FINANCE_ENTRY_HAS_OPEN_PAYMENT_INTENT'
    );
  });
});

test('A2: CONFIRMED do banco para lançamento já liquidado vira anomalia (pagamento em dobro), não erro em loop', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await payable(t);
    const intent = await submittedIntent(t, entry);
    // Simula o legado: lançamento liquidado por outro caminho enquanto a intenção estava no banco.
    await FinancialEntry.update({ status: 'SETTLED', settledAt: new Date() }, { where: { id: entry.id }, transaction: t });
    const result = await bankPaymentsService.confirmBankPayment(intent.externalSubmissionId, 'CONFIRMED', t);
    assert.equal(result.status, 'EXECUTED');
    assert.equal((await anomalies(t, intent.id, 'DUPLICATE_SETTLEMENT')).length, 1);
    // Reentrega: idempotente, sem erro e sem segundo caso.
    await bankPaymentsService.confirmBankPayment(intent.externalSubmissionId, 'CONFIRMED', t);
    assert.equal((await anomalies(t, intent.id, 'DUPLICATE_SETTLEMENT')).length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// A3 — classificação de excedente
// ---------------------------------------------------------------------------------------------

test('A3: excedente classificado como PAYABLE vira obrigação PENDENTE (com centro de custo), nunca saída de caixa automática', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const rc = await createTestResultCenter(tenant, t);
    const entry = await financialEntriesService.createFinancialEntry(
      W({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 100, description: 'PAY1810 recebível', resultCenterId: rc.id }),
      tenant.userId,
      t
    );
    const result = await financialEntriesService.settleFinancialEntryPartial(entry.id, 130, tenant.userId, t);
    const pendingId = result.classificationPending.id;
    await expectCode(financialEntriesService.resolveClassificationPending(pendingId, 'PAYABLE', tenant.userId, t), 'FINANCE_ENTRY_COST_CENTER_REQUIRED');
    const cc = await createTestCostCenter(tenant, t);
    const resolved = await financialEntriesService.resolveClassificationPending(pendingId, 'PAYABLE', tenant.userId, t, { costCenterId: cc.id });
    assert.equal(resolved.nature, 'PAYABLE');
    assert.equal(resolved.status, 'PENDING', 'devolução do excedente segue o fluxo normal de pagamento');
    assert.equal(resolved.settledAt, null);
  });
});

// ---------------------------------------------------------------------------------------------
// C1 — competência de mês fechado (lado de financialEntries; a guarda é da frente "fechamento")
// ---------------------------------------------------------------------------------------------

test('C1: competência de mês fechado não recebe nem perde lançamento (criação, update atual/novo, classificação)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { PeriodClosure } = require('../src/models');
    const { uniqueClosingTestMonth } = require('./testHelpers');
    let closedMonth = uniqueClosingTestMonth();
    let openMonth = uniqueClosingTestMonth();
    while (openMonth === closedMonth) openMonth = uniqueClosingTestMonth();
    const rc = await createTestResultCenter(tenant, t);
    const base = { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 50, description: 'PAY1810 C1', resultCenterId: rc.id, dueAt: '2060-06-10T15:00:00.000Z' };

    // Lançamento que já estava na competência antes de ela fechar, e outro num mês aberto.
    const insideClosed = await financialEntriesService.createFinancialEntry(W({ ...base, competenceMonth: closedMonth }), tenant.userId, t);
    const inOpen = await financialEntriesService.createFinancialEntry(W({ ...base, competenceMonth: openMonth }), tenant.userId, t);
    const excessSource = await financialEntriesService.createFinancialEntry(W({ ...base, competenceMonth: closedMonth }), tenant.userId, t);
    const { classificationPending } = await financialEntriesService.settleFinancialEntryPartial(excessSource.id, 80, tenant.userId, t);
    assert.equal(classificationPending.competenceMonth, closedMonth);

    await PeriodClosure.create(W({ referenceMonth: closedMonth, status: 'CLOSED', closedAt: new Date() }), { transaction: t });

    // Criação com vencimento num mês aberto mas competência no mês fechado.
    await expectCode(financialEntriesService.createFinancialEntry(W({ ...base, competenceMonth: closedMonth }), tenant.userId, t), 'FINANCE_PERIOD_CLOSED');
    // Mover PARA o mês fechado.
    await expectCode(financialEntriesService.updateFinancialEntry(inOpen.id, { competenceMonth: closedMonth }, tenant.userId, t), 'FINANCE_PERIOD_CLOSED');
    // Tirar DO mês fechado.
    await expectCode(financialEntriesService.updateFinancialEntry(insideClosed.id, { competenceMonth: openMonth }, tenant.userId, t), 'FINANCE_PERIOD_CLOSED');
    // Classificar o excedente que está na competência fechada.
    await expectCode(financialEntriesService.resolveClassificationPending(classificationPending.id, 'ADJUSTMENT', tenant.userId, t), 'FINANCE_PERIOD_CLOSED');

    const reread = await FinancialEntry.findByPk(inOpen.id, { transaction: t });
    assert.equal(reread.competenceMonth, openMonth);
  });
});

// ---------------------------------------------------------------------------------------------
// A4 — comprovante anexado, único, aprovado depois e por outra pessoa
// ---------------------------------------------------------------------------------------------

test('A4: comprovante informado só na baixa (sem anexar antes da aprovação) é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await payable(t);
    await approveFinancialEntryForSettlement(tenant, entry.id, tenant.userId, t);
    const manualSettlement = await createManualSettlementEvidence(tenant, tenant.userId, t);
    await expectCode(
      financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, t, { manualSettlement }),
      'FINANCE_SETTLEMENT_EVIDENCE_NOT_ATTACHED'
    );
  });
});

test('A4: anexar o comprovante invalida a aprovação anterior — aprovação precisa vir depois', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await payable(t);
    await approveFinancialEntryForSettlement(tenant, entry.id, tenant.userId, t);
    const manualSettlement = await createManualSettlementEvidence(tenant, tenant.userId, t);
    await financialEntriesService.attachSettlementEvidence(entry.id, manualSettlement, tenant.userId, t);
    await expectCode(
      financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, t, { manualSettlement }),
      'FINANCE_ENTRY_PAYABLE_REQUIRES_PAYMENT_INTENT_APPROVAL'
    );
    await approveFinancialEntryForSettlement(tenant, entry.id, tenant.userId, t);
    const settled = await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, t, { manualSettlement });
    assert.equal(settled.settlementMethod, 'MANUAL_WITH_EVIDENCE');
  });
});

test('A4: o mesmo comprovante não serve para duas baixas; comprovante precisa ser PDF ou imagem', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const a = await payable(t);
    const b = await payable(t);
    const manualSettlement = await createManualSettlementEvidence(tenant, tenant.userId, t);
    await financialEntriesService.attachSettlementEvidence(a.id, manualSettlement, tenant.userId, t);
    await expectCode(financialEntriesService.attachSettlementEvidence(b.id, manualSettlement, tenant.userId, t), 'FINANCE_SETTLEMENT_EVIDENCE_ALREADY_USED');

    const text = await filesService.uploadFile(
      W({ fileName: 'nota.txt', mimeType: 'text/plain', contentBase64: Buffer.from('x').toString('base64'), category: 'generic' }),
      tenant.userId,
      t
    ).catch(() => null);
    if (text) {
      await expectCode(
        financialEntriesService.attachSettlementEvidence(b.id, { evidenceFileId: text.id, reason: 'x' }, tenant.userId, t),
        'FINANCE_SETTLEMENT_EVIDENCE_INVALID_TYPE'
      );
    }
  });
});

test('A4: quem anexou o comprovante não pode ser quem aprovou a baixa manual', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await payable(t);
    const manualSettlement = await createManualSettlementEvidence(tenant, tenant.userId, t);
    await financialEntriesService.attachSettlementEvidence(entry.id, manualSettlement, approver.id, t);
    const request = await approvalsService.createApprovalRequest(
      W({ relatedEntityType: 'FinancialEntry', relatedEntityId: entry.id, riskLevel: 'LOW' }),
      tenant.userId,
      t
    );
    await approvalsService.decideApprovalStep(request.id, { decision: 'APPROVED' }, approver.id, t);
    await expectCode(
      financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, t, { manualSettlement }),
      'FINANCE_SETTLEMENT_EVIDENCE_SELF_APPROVAL'
    );
  });
});

test('A4: execução manual de intenção aprovada ANTES do comprovante é recusada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await payable(t);
    const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
    await paymentIntentsService.approvePaymentIntent(intent.id, approver.id, t);
    const manualSettlement = await createManualSettlementEvidence(tenant, tenant.userId, t);
    await financialEntriesService.attachSettlementEvidence(entry.id, manualSettlement, tenant.userId, t);
    await expectCode(
      paymentIntentsService.executePaymentIntent(intent.id, tenant.userId, t, { manualSettlement }),
      'FINANCE_SETTLEMENT_EVIDENCE_NOT_REVIEWED'
    );
  });
});

// ---------------------------------------------------------------------------------------------
// B1/B2 — submissão incerta, idempotência, reconciliação
// ---------------------------------------------------------------------------------------------

class FlakyBankAdapter {
  constructor() {
    this.isSandbox = true;
    this.calls = [];
    this.failNextSubmit = true;
    this.status = 'CONFIRMED';
  }

  async submitPayment(req) {
    this.calls.push(req.idempotencyKey);
    if (this.failNextSubmit) {
      this.failNextSubmit = false;
      throw new Error('timeout depois de o banco aceitar');
    }
    return { externalId: `flaky-${req.idempotencyKey}`, status: 'PENDING_EXTERNAL' };
  }

  async getPaymentStatus(externalId) {
    return { externalId, status: this.status };
  }
}

test('B1: erro/timeout na chamada ao banco deixa a intenção SUBMITTING (incerta) — nunca FAILED, nunca libera outra intenção', async () => {
  const adapter = new FlakyBankAdapter();
  setBankAdapterOverrideForTests(adapter);
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const entry = await payable(t);
      const intent = await submittedIntent(t, entry);
      assert.equal(intent.status, 'SUBMITTING');
      assert.equal(intent.externalStatus, 'UNCERTAIN');
      assert.equal(intent.idempotencyKey, `payment-intent:${intent.id}`);
      await expectCode(paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t), 'FINANCE_PAYMENT_INTENT_ALREADY_OPEN');
      await expectCode(paymentIntentsService.cancelPaymentIntent(intent.id, 'x', tenant.userId, t), 'FINANCE_PAYMENT_INTENT_INVALID_STATUS');

      // B2 — reconciliação reenvia com a MESMA chave (o provedor devolve o pagamento já criado),
      // obtém o id e consulta o status: CONFIRMED liquida.
      const { intent: after } = await bankPaymentsService.reconcilePaymentIntent(intent.id, { userId: null }, t);
      assert.deepEqual(adapter.calls, [`payment-intent:${intent.id}`, `payment-intent:${intent.id}`]);
      assert.equal(after.status, 'EXECUTED');
      const settled = await FinancialEntry.findByPk(entry.id, { transaction: t });
      assert.equal(settled.status, 'SETTLED');
      assert.equal(settled.settlementMethod, 'SANDBOX_CONFIRMED');
    });
  } finally {
    setBankAdapterOverrideForTests(null);
  }
});

test('B1: o adapter real envia a chave de idempotência ao provedor', async () => {
  const adapter = Object.create(SantanderBankAdapter.prototype);
  adapter.workspaceId = 'ws';
  let seenHeaders = null;
  adapter._request = async (method, path, payload, headers) => {
    seenHeaders = headers;
    return { id: 'ext-1' };
  };
  await adapter.submitPayment({ paymentMethod: 'PIX', idempotencyKey: 'payment-intent:abc', providerPayload: {} });
  assert.deepEqual(seenHeaders, { 'X-Idempotency-Key': 'payment-intent:abc' });
});

test('B2: ERROR é transitório (continua SUBMITTED); RETURNED depois de pago vira anomalia; resolver incerteza só com resposta final do banco', async () => {
  const adapter = new FlakyBankAdapter();
  adapter.failNextSubmit = false;
  setBankAdapterOverrideForTests(adapter);
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const entry = await payable(t);
      const intent = await submittedIntent(t, entry);
      const afterError = await bankPaymentsService.confirmBankPayment(intent.externalSubmissionId, 'error', t);
      assert.equal(afterError.status, 'SUBMITTED', 'ERROR não encerra como falha');

      adapter.status = 'PROCESSING';
      await expectCode(bankPaymentsService.resolveUncertainPaymentIntent(intent.id, { reason: '' }, { userId: tenant.userId }, t), 'FINANCE_PAYMENT_INTENT_RESOLUTION_REASON_REQUIRED');
      await expectCode(
        bankPaymentsService.resolveUncertainPaymentIntent(intent.id, { reason: 'conferido' }, { userId: tenant.userId }, t),
        'FINANCE_PAYMENT_INTENT_STILL_IN_TRANSIT'
      );
      adapter.status = 'REJECTED';
      const resolved = await bankPaymentsService.resolveUncertainPaymentIntent(intent.id, { reason: 'banco recusou' }, { userId: tenant.userId }, t);
      assert.equal(resolved.intent.status, 'FAILED');

      const entry2 = await payable(t);
      const intent2 = await submittedIntent(t, entry2);
      await bankPaymentsService.confirmBankPayment(intent2.externalSubmissionId, 'CONFIRMED', t);
      await bankPaymentsService.confirmBankPayment(intent2.externalSubmissionId, 'RETURNED', t);
      assert.equal((await anomalies(t, intent2.id, 'BANK_PAYMENT_RETURNED')).length, 1);
    });
  } finally {
    setBankAdapterOverrideForTests(null);
  }
});

// ---------------------------------------------------------------------------------------------
// B4/B5/B6
// ---------------------------------------------------------------------------------------------

test('B4: CONFIRMED depois de FAILED abre anomalia (dinheiro pode ter saído duas vezes)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await payable(t);
    const intent = await submittedIntent(t, entry);
    await bankPaymentsService.confirmBankPayment(intent.externalSubmissionId, 'REJECTED', t);
    const late = await bankPaymentsService.confirmBankPayment(intent.externalSubmissionId, 'CONFIRMED', t);
    assert.equal(late.status, 'FAILED');
    assert.equal((await anomalies(t, intent.id, 'LATE_BANK_CONFIRMATION')).length, 1);
  });
});

test('B5: confirmação via sandbox é SANDBOX_CONFIRMED; Santander incompleto falha fechado; sandbox proibido em produção', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await payable(t);
    const intent = await submittedIntent(t, entry);
    await bankPaymentsService.confirmBankPayment(intent.externalSubmissionId, 'CONFIRMED', t, { sandbox: true });
    const settled = await FinancialEntry.findByPk(entry.id, { transaction: t });
    assert.equal(settled.settlementMethod, 'SANDBOX_CONFIRMED');

    const settingsService = require('../src/features/settings/settings.service');
    const tenantRef = { groupId: tenant.groupId, companyId: tenant.companyId };
    await sequelize.query('SAVEPOINT b5', { transaction: t });
    await settingsService.upsertSetting('finance.payment_provider', 'santander', tenantRef, tenant.userId, t);
    await expectCode(resolveBankAdapter(tenantRef, t), 'FINANCE_BANK_PROVIDER_CONFIG_MISSING');
    await sequelize.query('ROLLBACK TO SAVEPOINT b5', { transaction: t });

    const previous = process.env.DEPLOY_ENVIRONMENT;
    process.env.DEPLOY_ENVIRONMENT = 'production';
    try {
      await expectCode(resolveBankAdapter({ groupId: tenant.groupId, companyId: tenant.companyId }, t), 'FINANCE_BANK_SANDBOX_FORBIDDEN_IN_PRODUCTION');
    } finally {
      if (previous === undefined) delete process.env.DEPLOY_ENVIRONMENT;
      else process.env.DEPLOY_ENVIRONMENT = previous;
    }
  });
});

test('B5: webhook bancário exige assinatura HMAC também em sandbox (sem segredo configurado, falha fechado)', async () => {
  const financeController = require('../src/features/finance/finance.controller');
  const { BankPaymentProviderRouting } = require('../src/models');
  // O webhook é público e abre a própria transação, então precisa de uma linha de roteamento
  // COMMITADA. Para não deixar lançamento no ledger (append-only, não pode ser apagado), só a
  // rota é commitada — apontando para uma intenção que não existe — e é apagada no fim. A
  // assinatura é conferida ANTES de qualquer acesso à intenção: sem HMAC, nada é processado.
  // No código antigo (sandbox sem HMAC) o webhook seguia para confirmBankPayment e o erro era
  // outro (intenção não encontrada) — o teste falha lá.
  const routing = await withCommitted((t) =>
    BankPaymentProviderRouting.create(
      { externalSubmissionId: `sandbox-pay1810-hmac-${uniqueSuffix()}`, paymentIntentId: require('crypto').randomUUID(), groupId: tenant.groupId, companyId: tenant.companyId },
      { transaction: t }
    )
  );
  try {
  const body = { externalSubmissionId: routing.externalSubmissionId, status: 'CONFIRMED' };
  const req = { body, rawBody: Buffer.from(JSON.stringify(body)), headers: {} };
  let statusCode = null;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  let caught = null;
  await new Promise((resolve) => {
    const done = () => resolve();
    const wrappedRes = { status(code) { res.status(code); return wrappedRes; }, json(data) { res.json(data); done(); return wrappedRes; } };
    financeController.bankPaymentPublicWebhook(req, wrappedRes, (err) => { caught = err; done(); });
  });
  const code = caught ? caught.code : payload && payload.error && payload.error.code;
  assert.equal(code, 'BANK_PAYMENT_WEBHOOK_HMAC_INVALID', `esperado bloqueio por HMAC, veio ${statusCode} ${JSON.stringify(payload)}`);
  } finally {
    await withCommitted((t) => BankPaymentProviderRouting.destroy({ where: { id: routing.id }, transaction: t }));
  }
});

test('B6: confirmação do banco não é recusada por controle de pré-pagamento (revisão manual posterior) — liquida e abre anomalia', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await payable(t);
    const intent = await submittedIntent(t, entry);
    await FinancialEntry.update({ requiresManualReview: true, manualReviewReason: 'teste B6' }, { where: { id: entry.id }, transaction: t });
    const result = await bankPaymentsService.confirmBankPayment(intent.externalSubmissionId, 'CONFIRMED', t);
    assert.equal(result.status, 'EXECUTED');
    const settled = await FinancialEntry.findByPk(entry.id, { transaction: t });
    assert.equal(settled.status, 'SETTLED');
    assert.equal((await anomalies(t, entry.id, 'BANK_CONFIRMATION_UNDER_REVIEW')).length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// D1-D3 — caução
// ---------------------------------------------------------------------------------------------

test('D1: estornar o recebimento da caução com devolução ativa é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { contract, holder } = await lease(t);
    const d = await deposit(t, { contract, holder, amount: 1000 });
    await release(t, { amount: 1000, thirdPartyOriginEntryId: d.id });
    await expectCode(financialEntriesService.reverseFinancialEntry(d.id, 'estorno', tenant.userId, t), 'FINANCE_THIRD_PARTY_ORIGIN_HAS_RELEASES');
    const balance = await financialEntriesService.computeThirdPartyOriginBalance(d.id, t);
    assert.equal(balance.available, '0.00');
  });
});

test('D2: caução sem contrato/titular é recusada; titular precisa ser locatário/comprador/fiador', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { contract, others } = await lease(t, ['LANDLORD', 'GUARANTOR']);
    const rc = await createTestResultCenter(tenant, t);
    const base = { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 10, description: 'PAY1810', resultCenterId: rc.id, isThirdPartyFunds: true, thirdPartyReference: 'C' };
    await expectCode(financialEntriesService.createFinancialEntry(W(base), tenant.userId, t), 'FINANCE_THIRD_PARTY_LINK_REQUIRED');
    await expectCode(
      financialEntriesService.createFinancialEntry(W({ ...base, contractId: contract.id, thirdPartyHolderPersonId: others.LANDLORD.id }), tenant.userId, t),
      'FINANCE_THIRD_PARTY_HOLDER_ROLE_INVALID'
    );
    const ok = await financialEntriesService.createFinancialEntry(W({ ...base, contractId: contract.id, thirdPartyHolderPersonId: others.GUARANTOR.id }), tenant.userId, t);
    assert.ok(ok.id);
  });
});

test('D3: baixa parcial da caução mantém a marca de terceiro; evento de saída só na liquidação', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { contract, holder } = await lease(t);
    const d = await deposit(t, { contract, holder, amount: 1000, settle: false });
    const r = await financialEntriesService.settleFinancialEntryPartial(d.id, 400, tenant.userId, t);
    assert.equal(r.settlement.isThirdPartyFunds, true);
    assert.equal(r.settlement.thirdPartyHolderPersonId, holder.id);

    const rel = await release(t, { amount: 200, thirdPartyOriginEntryId: d.id });
    const before = await OutboxEvent.findOne({ where: { idempotencyKey: `finance.third_party_funds.released:${rel.id}` }, transaction: t });
    assert.equal(before, null, 'devolução apenas criada (PENDING) não emite evento de saída');
    const manualSettlement = await prepareManualSettlement(tenant, rel.id, tenant.userId, t);
    await financialEntriesService.settleFinancialEntry(rel.id, tenant.userId, t, { manualSettlement });
    const afterEvent = await OutboxEvent.findOne({ where: { idempotencyKey: `finance.third_party_funds.released:${rel.id}` }, transaction: t });
    assert.ok(afterEvent, 'liquidação da devolução emite o evento');
  });
});

test('D3: compensação aponta a dívida do titular, exige aprovação, não move caixa e abate a dívida', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { contract, holder } = await lease(t);
    const d = await deposit(t, { contract, holder, amount: 1000 });
    const rc = await createTestResultCenter(tenant, t);
    const debt = await financialEntriesService.createFinancialEntry(
      W({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 300, description: 'PAY1810 dano de vistoria', resultCenterId: rc.id, contractId: contract.id }),
      tenant.userId,
      t
    );
    await expectCode(release(t, { amount: 300, thirdPartyOriginEntryId: d.id, thirdPartyReleaseType: 'COMPENSATION' }), 'FINANCE_THIRD_PARTY_COMPENSATED_DEBT_REQUIRED');
    await expectCode(
      release(t, { amount: 400, thirdPartyOriginEntryId: d.id, thirdPartyReleaseType: 'COMPENSATION', thirdPartyCompensatedEntryId: debt.id }),
      'FINANCE_THIRD_PARTY_COMPENSATION_EXCEEDS_DEBT'
    );
    const comp = await release(t, { amount: 300, thirdPartyOriginEntryId: d.id, thirdPartyReleaseType: 'COMPENSATION', thirdPartyCompensatedEntryId: debt.id });
    await expectCode(financialEntriesService.settleFinancialEntry(comp.id, tenant.userId, t), 'FINANCE_ENTRY_PAYABLE_REQUIRES_PAYMENT_INTENT_APPROVAL');
    await approveFinancialEntryForSettlement(tenant, comp.id, tenant.userId, t);
    const settled = await financialEntriesService.settleFinancialEntry(comp.id, tenant.userId, t);
    assert.equal(settled.settlementMethod, 'COMPENSATION');
    const debtAfter = await FinancialEntry.findByPk(debt.id, { transaction: t });
    assert.equal(debtAfter.status, 'SETTLED', 'a dívida do titular foi abatida');
    const balance = await financialEntriesService.computeThirdPartyOriginBalance(d.id, t);
    assert.equal(balance.available, '700.00');
  });
});

// ---------------------------------------------------------------------------------------------
// E1 — fila de aprovação
// ---------------------------------------------------------------------------------------------

test('E1: solicitação de aprovação recusa tipo inventado e entidade inexistente', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await expectCode(
      approvalsService.createApprovalRequest(W({ relatedEntityType: 'QualquerCoisa', relatedEntityId: '11111111-1111-1111-1111-111111111111' }), tenant.userId, t),
      'FINANCE_APPROVAL_VALIDATION'
    );
    await expectCode(
      approvalsService.createApprovalRequest(W({ relatedEntityType: 'FinancialEntry', relatedEntityId: '11111111-1111-1111-1111-111111111111' }), tenant.userId, t),
      'FINANCE_APPROVAL_RELATED_ENTITY_NOT_FOUND'
    );
    assert.equal(await ApprovalRequest.count({ where: { relatedEntityId: '11111111-1111-1111-1111-111111111111' }, transaction: t }), 0);
  });
});

// ---------------------------------------------------------------------------------------------
// B3/D4 — concorrência real (duas conexões)
//
// finance.financial_entries é append-only (DELETE bloqueado por trigger), então um teste com
// duas conexões que COMMITA deixaria lançamentos para sempre no banco compartilhado. Por isso:
//   - o lançamento/caução de base é um fixture ESTÁVEL (criado uma única vez, achado pela chave
//     de idempotência nas execuções seguintes, nunca alterado — as transações dos testes sofrem
//     ROLLBACK);
//   - a concorrência é provada com duas transações abertas ao mesmo tempo: a 1ª cria e segura; a
//     2ª, com lock_timeout curto, precisa ficar BLOQUEADA no SELECT ... FOR UPDATE (55P03) — ou
//     seja, não consegue passar pela checagem enquanto a 1ª não termina. Depois as duas sofrem
//     rollback. A garantia final (índice único parcial / revalidação do saldo) é provada na
//     própria 1ª transação.
// ---------------------------------------------------------------------------------------------

async function withCommitted(fn) {
  const t = await openTenantTx();
  try {
    const r = await fn(t);
    await t.commit();
    return r;
  } catch (err) {
    await t.rollback().catch(() => {});
    throw err;
  }
}

async function openTenantTx() {
  const t = await sequelize.transaction();
  await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", {
    replacements: { g: tenant.groupId, c: tenant.companyId, u: tenant.userId },
    transaction: t,
  });
  return t;
}

async function stableFixture(idempotencyKey, build) {
  return withCommitted(async (t) => {
    const existing = await FinancialEntry.findOne({ where: { idempotencyKey }, transaction: t });
    return existing || build(t, idempotencyKey);
  });
}

function assertBlockedOnRowLock(err) {
  const code = err && (err.parent?.code || err.original?.code);
  assert.equal(code, '55P03', `esperava ficar bloqueado esperando o lock (55P03), veio: ${err && err.code} ${err && err.message}`);
  assert.match(String(err.sql || ''), /FOR UPDATE/, `o bloqueio precisa ser no SELECT ... FOR UPDATE (antes da checagem), veio: ${err.sql}`);
}

test('B3: duas criações SIMULTÂNEAS de intenção para o mesmo lançamento — a 2ª espera o lock; o índice único barra a duplicata', async () => {
  const entry = await stableFixture('PAY1810-FIXTURE-B3-v1', async (t, key) => {
    const cc = await createTestCostCenter(tenant, t);
    const ba = await bank(t);
    return financialEntriesService.createFinancialEntry(
      W({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 300, description: 'PAY1810 FIXTURE B3 (concorrência — nunca liquidar)', costCenterId: cc.id, bankAccountId: ba.id, dueAt: '2076-12-01T15:00:00.000Z', idempotencyKey: key }),
      tenant.userId,
      t
    );
  });
  assert.equal(entry.status, 'PENDING', 'fixture estável do B3 precisa continuar PENDING');
  const t1 = await openTenantTx();
  const t2 = await openTenantTx();
  try {
    const first = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t1);
    assert.equal(first.status, 'PENDING');

    await sequelize.query("SET LOCAL lock_timeout = '1500ms'", { transaction: t2 });
    await assert.rejects(
      () => paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t2),
      (err) => { assertBlockedOnRowLock(err); return true; }
    );

    // Garantia final no banco: mesmo um INSERT direto (sem passar pela checagem) não abre uma
    // segunda intenção em aberto para o mesmo lançamento.
    await sequelize.query('SAVEPOINT b3_dup', { transaction: t1 });
    await assert.rejects(
      () => PaymentIntent.create(
        { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryId: entry.id, status: 'PENDING', snapshotJson: first.snapshotJson, snapshotHash: first.snapshotHash, createdBy: tenant.userId },
        { transaction: t1 }
      ),
      (err) => { assert.equal(err.name, 'SequelizeUniqueConstraintError', err.message); return true; }
    );
    await sequelize.query('ROLLBACK TO SAVEPOINT b3_dup', { transaction: t1 });
  } finally {
    await t2.rollback().catch(() => {});
    await t1.rollback().catch(() => {});
  }
  const open = await withCommitted((t) => PaymentIntent.count({ where: { financialEntryId: entry.id }, transaction: t }));
  assert.equal(open, 0, 'nada do teste ficou commitado');
});

test('D4: duas devoluções SIMULTÂNEAS da mesma caução — a 2ª espera o lock da origem; juntas não passam do saldo', async () => {
  const origin = await stableFixture('PAY1810-FIXTURE-D4-ORIGIN-v1', async (t, key) => {
    const { contract, holder } = await lease(t);
    const rc = await createTestResultCenter(tenant, t);
    const d = await financialEntriesService.createFinancialEntry(
      W({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 1000, description: 'PAY1810 FIXTURE D4 caução (concorrência — nunca devolver)', resultCenterId: rc.id, contractId: contract.id, isThirdPartyFunds: true, thirdPartyReference: 'Caução', thirdPartyHolderPersonId: holder.id, idempotencyKey: key }),
      tenant.userId,
      t
    );
    await financialEntriesService.settleFinancialEntry(d.id, tenant.userId, t);
    return FinancialEntry.findByPk(d.id, { transaction: t });
  });
  const startBalance = await withCommitted((t) => financialEntriesService.computeThirdPartyOriginBalance(origin.id, t));
  assert.equal(startBalance.available, '1000.00', 'fixture estável do D4 precisa continuar com o saldo cheio');

  const t1 = await openTenantTx();
  const t2 = await openTenantTx();
  try {
    await release(t1, { amount: 700, thirdPartyOriginEntryId: origin.id });

    await sequelize.query("SET LOCAL lock_timeout = '1500ms'", { transaction: t2 });
    await assert.rejects(
      () => release(t2, { amount: 700, thirdPartyOriginEntryId: origin.id }),
      (err) => { assertBlockedOnRowLock(err); return true; }
    );

    // Serializada atrás da 1ª, a 2ª devolução vê o saldo já consumido.
    await expectCode(release(t1, { amount: 700, thirdPartyOriginEntryId: origin.id }), 'FINANCE_THIRD_PARTY_RELEASE_EXCEEDS_BALANCE');
    const balance = await financialEntriesService.computeThirdPartyOriginBalance(origin.id, t1);
    assert.equal(balance.available, '300.00');
  } finally {
    await t2.rollback().catch(() => {});
    await t1.rollback().catch(() => {});
  }
  const endBalance = await withCommitted((t) => financialEntriesService.computeThirdPartyOriginBalance(origin.id, t));
  assert.equal(endBalance.available, '1000.00', 'nada do teste ficou commitado');
});
