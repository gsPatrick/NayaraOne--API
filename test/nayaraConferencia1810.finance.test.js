'use strict';

// Conferência da IA da Nayara, 18/10/2026 (Maturacao/CONFERENCIA_MARCOS4_5_18-10_CHECKLIST.md),
// pendências do Financeiro:
//   F02 — pré-condições do fechamento (Caderno §16 / Guia §12) + snapshot imutável.
//   F03 — baixa direta de pagamento bancário sem confirmação do banco (Caderno §8).
//   F04 — devolução/compensação de caução sem vínculo com origem, contrato e titular (§13).
// Regra da auditoria: cada teste falha antes da correção e passa depois, contra Postgres real
// (RLS ativo) e pela rota HTTP aplicável. Nenhum dinheiro real: o provedor bancário é o
// SandboxBankAdapter (fallback padrão sem credencial).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.CONFERENCIA_1810_HTTP_TEST_PORT || '21601';

const app = require('../app');
const {
  sequelize,
  getSeedTenant,
  withRollbackTenantTransaction,
  withTenantTransaction,
  uniqueSuffix,
  createTestCostCenter,
  createTestResultCenter,
  approveFinancialEntryForSettlement,
} = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { encryptSecret } = require('../src/utils/mfaCrypto');
const {
  User,
  Person,
  Contract,
  ContractParty,
  BankAccount,
  BankTransaction,
  FinancialEntry,
  PeriodClosure,
  PeriodClosureSnapshot,
  MfaCredential,
  MfaStepUp,
  OutboxEvent,
} = require('../src/models');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const periodClosuresService = require('../src/features/finance/periodClosures.service');
const reconciliationService = require('../src/features/finance/reconciliation.service');
const paymentIntentsService = require('../src/features/finance/paymentIntents.service');
const bankPaymentsService = require('../src/features/finance/bankPayments.service');
const filesService = require('../src/features/files/files.service');

let tenant;
let baseUrl;
let approverUser;
let mfaUser;

function randomMonth(fromYear, toYear) {
  const year = fromYear + Math.floor(Math.random() * (toYear - fromYear + 1));
  const month = 1 + Math.floor(Math.random() * 12);
  return `${year}-${String(month).padStart(2, '0')}`;
}

function dueAtIn(referenceMonth) {
  return `${referenceMonth}-15T12:00:00.000Z`;
}

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `esperado ${code}, veio ${err.code}: ${err.message}`);
    return true;
  });
}

async function createEvidenceFile(transaction, name = 'comprovante.pdf') {
  return filesService.uploadFile(
    withTenant({ fileName: name, mimeType: 'application/pdf', contentBase64: Buffer.from(`COMPROVANTE ${uniqueSuffix()}`).toString('base64'), category: 'generic' }),
    tenant.userId,
    transaction
  );
}

async function createActiveBankAccount(transaction) {
  return BankAccount.create(
    withTenant({ bankCode: '001', agency: '0001', accountNumber: `CONF1810-${uniqueSuffix()}`, pixKey: `conf1810-${uniqueSuffix()}@nayaraone.dev`, status: 'ACTIVE' }),
    { transaction }
  );
}

async function createBankPayable(transaction, { amount = 300, referenceMonth } = {}) {
  const costCenter = await createTestCostCenter(tenant, transaction);
  const bankAccount = await createActiveBankAccount(transaction);
  const entry = await financialEntriesService.createFinancialEntry(
    withTenant({
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount,
      description: `CONF1810 pagamento ${uniqueSuffix()}`,
      costCenterId: costCenter.id,
      bankAccountId: bankAccount.id,
      dueAt: referenceMonth ? dueAtIn(referenceMonth) : new Date(Date.now() + 86400000),
    }),
    tenant.userId,
    transaction
  );
  return { entry, bankAccount };
}

async function withCommitted(fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
    const result = await fn(t);
    await t.commit();
    return result;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// Usuário de teste com MFA habilitado e verificação recente gravados direto no banco (fixture,
// NUNCA pelo endpoint real de MFA): as rotas sensíveis exigem requireRecentMfa.
async function createMfaUser(label) {
  const [user] = await User.findOrCreate({
    where: { email: `homo-qa-conf1810-${label}-${uniqueSuffix()}@nayaraone.dev` },
    defaults: { name: `HOMO QA — Conferência 18/10 ${label}`, passwordHash: 'x', status: 'ACTIVE', mfaEnabled: true, mfaMethod: 'TOTP' },
  });
  await withCommitted(async (t) => {
    await MfaCredential.create(
      withTenant({ userId: user.id, secretEncrypted: encryptSecret('JBSWY3DPEHPK3PXP'), enabled: true, confirmedAt: new Date(), recoveryCodesHash: [] }),
      { transaction: t }
    );
    await MfaStepUp.create(
      withTenant({ userId: user.id, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60 * 1000) }),
      { transaction: t }
    );
  });
  return user;
}

function tokenFor(userId, permissions) {
  return signAccessToken({ sub: userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions });
}

async function http(method, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

before(async () => {
  tenant = await getSeedTenant();
  const [approver] = await User.findOrCreate({
    where: { email: 'homo-qa-conf1810-approver@nayaraone.dev' },
    defaults: { name: 'HOMO QA — Aprovador conferência 18/10', passwordHash: 'x', status: 'ACTIVE' },
  });
  approverUser = approver;
  mfaUser = await createMfaUser('mfa');
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  // Mesmo padrão dos demais testes HTTP: app.listen incondicional mantém o processo vivo.
  process.exit(0);
});

// =============================================================================================
// F02 — pré-condições do fechamento financeiro
// =============================================================================================

async function confirmBothChecks(referenceMonth, transaction) {
  await periodClosuresService.confirmPeriodCheck(
    withTenant({ referenceMonth, checkType: 'THIRD_PARTY_CASH', note: 'Caixa de terceiros conferido contra o extrato da conta de cauções.' }),
    tenant.userId,
    transaction
  );
  await periodClosuresService.confirmPeriodCheck(
    withTenant({ referenceMonth, checkType: 'COMMISSIONS_REPASSES', note: 'Comissões e repasses do mês revisados com o financeiro.' }),
    tenant.userId,
    transaction
  );
}

async function expectPreconditionFailure(promise, expectedCodes) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, 'FINANCE_PERIOD_PRECONDITIONS_NOT_MET', err.message);
    const missing = (err.details && err.details.missing) || [];
    assert.deepEqual(missing.map((m) => m.code).sort(), [...expectedCodes].sort());
    return true;
  });
}

test('F02-1: sem as conferências de caixa de terceiros e de comissões/repasses, o pedido de fechamento é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = randomMonth(2066, 2075);
    await expectPreconditionFailure(
      periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction),
      ['THIRD_PARTY_CASH_CHECKED', 'COMMISSIONS_REPASSES_REVIEWED']
    );
    const closure = await PeriodClosure.findOne({ where: { companyId: tenant.companyId, referenceMonth }, transaction });
    assert.equal(closure, null, 'nada pode ir para REVIEW');
  });
});

test('F02-2: conta bancária movimentada no mês sem extrato importado bloqueia o fechamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = randomMonth(2066, 2075);
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const bankAccount = await createActiveBankAccount(transaction);
    const receipt = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 800, description: 'CONF1810 F02-2 recebimento', resultCenterId: resultCenter.id, bankAccountId: bankAccount.id, dueAt: dueAtIn(referenceMonth) }),
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(receipt.id, tenant.userId, transaction);
    await confirmBothChecks(referenceMonth, transaction);

    await expectPreconditionFailure(
      periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction),
      ['BANK_STATEMENTS_IMPORTED']
    );
  });
});

test('F02-3: transação de extrato do mês sem conciliação bloqueia o fechamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = randomMonth(2066, 2075);
    const bankAccount = await createActiveBankAccount(transaction);
    await BankTransaction.create(
      withTenant({ bankAccountId: bankAccount.id, amount: 123.45, transactionDate: dueAtIn(referenceMonth), description: 'CONF1810 F02-3 sem conciliação' }),
      { transaction }
    );
    await confirmBothChecks(referenceMonth, transaction);

    await expectPreconditionFailure(
      periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction),
      ['RECONCILIATION_PENDINGS']
    );
  });
});

test('F02-4: excedente aguardando classificação no mês bloqueia o fechamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = randomMonth(2066, 2075);
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const receivable = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 100, description: 'CONF1810 F02-4', resultCenterId: resultCenter.id, dueAt: dueAtIn(referenceMonth) }),
      tenant.userId,
      transaction
    );
    // Recebe 150 sobre 100: os 50 excedentes viram PENDING_CLASSIFICATION (Caderno §10).
    await financialEntriesService.settleFinancialEntryPartial(receivable.id, 150, tenant.userId, transaction);
    await confirmBothChecks(referenceMonth, transaction);

    await expectPreconditionFailure(
      periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction),
      ['CLASSIFICATION_PENDINGS']
    );
  });
});

test('F02-5: conferência de caixa de terceiros fica desatualizada se o movimento de terceiros muda depois dela', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = randomMonth(2066, 2075);
    await confirmBothChecks(referenceMonth, transaction);
    await periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction);

    // Depois do pedido de revisão, entra uma caução no mês: o caixa conferido já não é o atual.
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const deposit = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 900, description: 'CONF1810 F02-5 caução', resultCenterId: resultCenter.id, dueAt: dueAtIn(referenceMonth), isThirdPartyFunds: true, thirdPartyReference: 'Caução F02-5' }),
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(deposit.id, tenant.userId, transaction);

    await expectPreconditionFailure(
      periodClosuresService.approvePeriodClosure(withTenant({ referenceMonth }), approverUser.id, transaction),
      ['THIRD_PARTY_CASH_CHECKED']
    );
  });
});

test('F02-6: controle positivo — com tudo conferido o período vai a REVIEW, fecha em CLOSED e grava snapshot íntegro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = randomMonth(2066, 2075);
    // Mês com movimento bancário real, extrato importado e conciliado.
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const bankAccount = await createActiveBankAccount(transaction);
    const receipt = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 640, description: 'CONF1810 F02-6 aluguel', resultCenterId: resultCenter.id, bankAccountId: bankAccount.id, dueAt: dueAtIn(referenceMonth) }),
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(receipt.id, tenant.userId, transaction);
    const bankTx = await BankTransaction.create(
      withTenant({ bankAccountId: bankAccount.id, amount: 640, transactionDate: dueAtIn(referenceMonth), description: 'CONF1810 F02-6 extrato' }),
      { transaction }
    );
    await reconciliationService.matchReconciliation(withTenant({ financialEntryId: receipt.id, bankTransactionId: bankTx.id }), tenant.userId, transaction);
    await confirmBothChecks(referenceMonth, transaction);

    const { preconditions } = await periodClosuresService.getPeriodPreconditions(withTenant({ referenceMonth }), transaction);
    assert.equal(preconditions.allOk, true, JSON.stringify(preconditions.items));

    const inReview = await periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction);
    assert.equal(inReview.status, 'REVIEW');

    const closed = await periodClosuresService.approvePeriodClosure(withTenant({ referenceMonth }), approverUser.id, transaction);
    assert.equal(closed.status, 'CLOSED');
    assert.ok(closed.currentSnapshotId, 'o fechamento aponta para o snapshot gravado');

    const snapshot = await PeriodClosureSnapshot.findByPk(closed.currentSnapshotId, { transaction });
    assert.equal(snapshot.referenceMonth, referenceMonth);
    assert.equal(periodClosuresService.verifySnapshotIntegrity(snapshot), true, 'hash do snapshot confere com o conteúdo');
    assert.equal(snapshot.snapshotJson.approvedByUserId, approverUser.id);
    assert.ok(snapshot.snapshotJson.preconditions.every((item) => item.ok));
    const receivableSettled = snapshot.snapshotJson.totalsByNatureAndStatus.find((row) => row.nature === 'RECEIVABLE' && row.status === 'SETTLED');
    assert.equal(receivableSettled.sum, '640.00');

    const event = await OutboxEvent.findOne({ where: { idempotencyKey: `finance.period.closed:${snapshot.id}` }, transaction });
    assert.ok(event, 'evento finance.period.closed publicado (Guia §12)');
  });
});

test('F02-7: o snapshot do fechamento é imutável no banco (UPDATE e DELETE recusados)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const referenceMonth = randomMonth(2066, 2075);
    await confirmBothChecks(referenceMonth, transaction);
    await periodClosuresService.closePeriod(withTenant({ referenceMonth }), tenant.userId, transaction);
    const closed = await periodClosuresService.approvePeriodClosure(withTenant({ referenceMonth }), approverUser.id, transaction);

    await sequelize.query('SAVEPOINT conf1810_snapshot_update', { transaction });
    await assert.rejects(
      () => sequelize.query(`UPDATE finance.period_closure_snapshots SET snapshot_hash = 'x' WHERE id = :id`, { replacements: { id: closed.currentSnapshotId }, transaction }),
      /imutável/
    );
    await sequelize.query('ROLLBACK TO SAVEPOINT conf1810_snapshot_update', { transaction });
    await assert.rejects(
      () => sequelize.query('DELETE FROM finance.period_closure_snapshots WHERE id = :id', { replacements: { id: closed.currentSnapshotId }, transaction }),
      /imutável/
    );
  });
});

test('F02-8 (HTTP): a rota de fechamento bloqueia sem pré-condições, expõe o checklist e fecha com tudo conferido', async () => {
  const referenceMonth = randomMonth(2066, 2075);
  const requesterToken = tokenFor(tenant.userId, ['finance:read', 'finance:settle']);

  const pre = await http('GET', `/finance/period-closures/${referenceMonth}/preconditions`, requesterToken);
  assert.equal(pre.status, 200);
  assert.equal(pre.body.data.preconditions.allOk, false);
  assert.deepEqual(pre.body.data.preconditions.items.map((item) => item.code), [
    'BANK_STATEMENTS_IMPORTED',
    'RECONCILIATION_PENDINGS',
    'CLASSIFICATION_PENDINGS',
    'THIRD_PARTY_CASH_CHECKED',
    'COMMISSIONS_REPASSES_REVIEWED',
  ]);

  const blocked = await http('POST', '/finance/period-closures', requesterToken, { referenceMonth });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'FINANCE_PERIOD_PRECONDITIONS_NOT_MET');

  for (const checkType of ['THIRD_PARTY_CASH', 'COMMISSIONS_REPASSES']) {
    const check = await http('POST', '/finance/period-closures/checks', requesterToken, { referenceMonth, checkType, note: `Conferência HTTP ${checkType}` });
    assert.equal(check.status, 200, JSON.stringify(check.body));
  }

  const review = await http('POST', '/finance/period-closures', requesterToken, { referenceMonth });
  assert.equal(review.status, 201, JSON.stringify(review.body));
  assert.equal(review.body.data.status, 'REVIEW');

  const approverToken = tokenFor(mfaUser.id, ['finance:read', 'finance:approve']);
  const approved = await http('POST', '/finance/period-closures/approve', approverToken, { referenceMonth });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.status, 'CLOSED');

  const after = await http('GET', `/finance/period-closures/${referenceMonth}/preconditions`, requesterToken);
  assert.equal(after.body.data.status, 'CLOSED');
  assert.ok(after.body.data.snapshot && after.body.data.snapshot.snapshotHash, 'snapshot exposto na leitura do fechamento');
});

// =============================================================================================
// F03 — baixa direta versus confirmação bancária
// =============================================================================================

test('F03-1: baixa direta de pagamento bancário aprovado, sem comprovante, é recusada e não liquida nada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry } = await createBankPayable(transaction);
    await approveFinancialEntryForSettlement(tenant, entry.id, tenant.userId, transaction);

    await expectCode(
      financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction),
      'FINANCE_ENTRY_BANK_SETTLEMENT_REQUIRES_CONFIRMATION'
    );
    await expectCode(
      financialEntriesService.settleFinancialEntryPartial(entry.id, 100, tenant.userId, transaction),
      'FINANCE_ENTRY_BANK_SETTLEMENT_REQUIRES_CONFIRMATION'
    );
    const reloaded = await FinancialEntry.findByPk(entry.id, { transaction });
    assert.equal(reloaded.status, 'PENDING', 'sem confirmação nem comprovante o pagamento continua pendente');
    const children = await FinancialEntry.count({ where: { parentEntryId: entry.id }, transaction });
    assert.equal(children, 0, 'nenhuma baixa parcial foi registrada');
  });
});

test('F03-2: comprovante inexistente ou motivo vazio não servem como exceção', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry } = await createBankPayable(transaction);
    await approveFinancialEntryForSettlement(tenant, entry.id, tenant.userId, transaction);
    const evidence = await createEvidenceFile(transaction);

    await expectCode(
      financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction, {
        manualSettlement: { evidenceFileId: '00000000-0000-4000-8000-000000000000', reason: 'TED feita no internet banking' },
      }),
      'FINANCE_SETTLEMENT_EVIDENCE_NOT_FOUND'
    );
    await expectCode(
      financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction, { manualSettlement: { evidenceFileId: evidence.id, reason: '   ' } }),
      'FINANCE_ENTRY_BANK_SETTLEMENT_REQUIRES_CONFIRMATION'
    );
  });
});

test('F03-3: exceção formal — baixa manual com comprovante, motivo e aprovação fica marcada como manual, nunca como confirmação bancária', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry } = await createBankPayable(transaction);
    await approveFinancialEntryForSettlement(tenant, entry.id, tenant.userId, transaction);
    const evidence = await createEvidenceFile(transaction);

    const settled = await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction, {
      manualSettlement: { evidenceFileId: evidence.id, reason: 'TED feita no internet banking em 18/10' },
    });
    assert.equal(settled.status, 'SETTLED');
    assert.equal(settled.settlementMethod, 'MANUAL_WITH_EVIDENCE');
    assert.equal(settled.settlementEvidenceFileId, evidence.id);
    assert.equal(settled.settlementReason, 'TED feita no internet banking em 18/10');
  });
});

test('F03-4: baixa manual continua exigindo a aprovação prévia — comprovante não substitui o maker-checker', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry } = await createBankPayable(transaction);
    const evidence = await createEvidenceFile(transaction);
    await expectCode(
      financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction, {
        manualSettlement: { evidenceFileId: evidence.id, reason: 'sem aprovação' },
      }),
      'FINANCE_ENTRY_PAYABLE_REQUIRES_PAYMENT_INTENT_APPROVAL'
    );
  });
});

test('F03-5: executar manualmente uma intenção aprovada sem passar pelo banco também exige comprovante', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry } = await createBankPayable(transaction);
    const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, transaction);
    await paymentIntentsService.approvePaymentIntent(intent.id, approverUser.id, transaction);

    await expectCode(
      paymentIntentsService.executePaymentIntent(intent.id, tenant.userId, transaction),
      'FINANCE_ENTRY_BANK_SETTLEMENT_REQUIRES_CONFIRMATION'
    );
    const evidence = await createEvidenceFile(transaction);
    const result = await paymentIntentsService.executePaymentIntent(intent.id, tenant.userId, transaction, {
      manualSettlement: { evidenceFileId: evidence.id, reason: 'Pago fora da integração' },
    });
    assert.equal(result.entry.settlementMethod, 'MANUAL_WITH_EVIDENCE');
  });
});

test('F03-6: caminho do banco — só a confirmação efetiva liquida, e fica marcada como BANK_CONFIRMED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { entry } = await createBankPayable(transaction);
    const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, transaction);
    await paymentIntentsService.approvePaymentIntent(intent.id, approverUser.id, transaction);
    const submitted = await bankPaymentsService.submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, transaction);

    const beforeConfirm = await FinancialEntry.findByPk(entry.id, { transaction });
    assert.equal(beforeConfirm.status, 'PENDING', 'enviar ao banco não é pagar');

    await bankPaymentsService.confirmBankPayment(submitted.externalSubmissionId, 'CONFIRMED', transaction);
    const confirmed = await FinancialEntry.findByPk(entry.id, { transaction });
    assert.equal(confirmed.status, 'SETTLED');
    assert.equal(confirmed.settlementMethod, 'BANK_CONFIRMED');
    assert.equal(confirmed.settlementEvidenceFileId, null);
  });
});

test('F03-7: recebimentos e pagamentos sem conta bancária seguem o fluxo direto de antes (sem regressão)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const costCenter = await createTestCostCenter(tenant, transaction);
    const receivable = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 50, description: 'CONF1810 F03-7 receber', resultCenterId: resultCenter.id }),
      tenant.userId,
      transaction
    );
    const payableNoBank = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 70, description: 'CONF1810 F03-7 contábil', costCenterId: costCenter.id }),
      tenant.userId,
      transaction
    );
    const r = await financialEntriesService.settleFinancialEntry(receivable.id, tenant.userId, transaction);
    const p = await financialEntriesService.settleFinancialEntry(payableNoBank.id, tenant.userId, transaction);
    assert.equal(r.status, 'SETTLED');
    assert.equal(p.status, 'SETTLED');
    assert.equal(r.settlementMethod, null);
    assert.equal(p.settlementMethod, null);
  });
});

test('F03-8 (HTTP): POST /finance/entries/:id/settle recusa sem comprovante e aceita a exceção formal com comprovante', async () => {
  const { entryId, evidenceId } = await withCommitted(async (t) => {
    const { entry } = await createBankPayable(t, { amount: 210, referenceMonth: randomMonth(2056, 2063) });
    await approveFinancialEntryForSettlement(tenant, entry.id, tenant.userId, t);
    const evidence = await createEvidenceFile(t, 'comprovante-http.pdf');
    return { entryId: entry.id, evidenceId: evidence.id };
  });
  const token = tokenFor(mfaUser.id, ['finance:read', 'finance:settle']);

  const refused = await http('POST', `/finance/entries/${entryId}/settle`, token, {});
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'FINANCE_ENTRY_BANK_SETTLEMENT_REQUIRES_CONFIRMATION');

  const accepted = await http('POST', `/finance/entries/${entryId}/settle`, token, {
    settlementEvidenceFileId: evidenceId,
    settlementReason: 'TED feita no internet banking — comprovante anexado',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.status, 'SETTLED');
  assert.equal(accepted.body.data.settlementMethod, 'MANUAL_WITH_EVIDENCE');
});

// =============================================================================================
// F04 — rastreabilidade da caução
// =============================================================================================

async function createLeaseWithTenantParty(transaction) {
  const suffix = uniqueSuffix();
  const contract = await Contract.create(
    withTenant({ contractType: 'LEASE', contractNumber: `CONF1810-CAU-${suffix}`, status: 'ACTIVE', createdBy: tenant.userId, updatedBy: tenant.userId }),
    { transaction }
  );
  const holder = await Person.create(
    withTenant({ personType: 'PF', legalName: `CONF1810 Locatário ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId }),
    { transaction }
  );
  await ContractParty.create(withTenant({ contractId: contract.id, personId: holder.id, partyRole: 'TENANT' }), { transaction });
  return { contract, holder };
}

async function receiveDeposit(transaction, { contract, holder, amount = 2000 }) {
  const resultCenter = await createTestResultCenter(tenant, transaction);
  const deposit = await financialEntriesService.createFinancialEntry(
    withTenant({
      entryType: 'CREDIT',
      nature: 'RECEIVABLE',
      amount,
      description: 'CONF1810 caução recebida',
      resultCenterId: resultCenter.id,
      contractId: contract.id,
      isThirdPartyFunds: true,
      thirdPartyReference: `Caução contrato ${contract.contractNumber}`,
      thirdPartyHolderPersonId: holder.id,
    }),
    tenant.userId,
    transaction
  );
  await financialEntriesService.settleFinancialEntry(deposit.id, tenant.userId, transaction);
  return deposit;
}

async function releaseDeposit(transaction, fields) {
  const costCenter = await createTestCostCenter(tenant, transaction);
  return financialEntriesService.createFinancialEntry(
    withTenant({
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      description: 'CONF1810 devolução/compensação de caução',
      costCenterId: costCenter.id,
      isThirdPartyFunds: true,
      thirdPartyReference: 'Devolução de caução',
      ...fields,
    }),
    tenant.userId,
    transaction
  );
}

test('F04-1: devolução e compensação ligadas à origem, contrato e titular, com saldo e trilha', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, holder } = await createLeaseWithTenantParty(transaction);
    const deposit = await receiveDeposit(transaction, { contract, holder, amount: 2000 });

    const partialReturn = await releaseDeposit(transaction, { amount: 1500, thirdPartyOriginEntryId: deposit.id });
    assert.equal(partialReturn.thirdPartyOriginEntryId, deposit.id);
    assert.equal(partialReturn.contractId, contract.id, 'contrato herdado da origem');
    assert.equal(partialReturn.thirdPartyHolderPersonId, holder.id, 'titular herdado da origem');

    let balance = await financialEntriesService.computeThirdPartyOriginBalance(deposit.id, transaction);
    assert.deepEqual([balance.received, balance.released, balance.available], ['2000.00', '1500.00', '500.00']);

    // Compensação do saldo restante (ex.: abater dano de vistoria), informando contrato e titular.
    await releaseDeposit(transaction, { amount: 500, thirdPartyOriginEntryId: deposit.id, contractId: contract.id, thirdPartyHolderPersonId: holder.id });
    balance = await financialEntriesService.computeThirdPartyOriginBalance(deposit.id, transaction);
    assert.equal(balance.available, '0.00');
    assert.equal(balance.releases.length, 2);

    const event = await OutboxEvent.findOne({ where: { idempotencyKey: `finance.third_party_funds.released:${partialReturn.id}` }, transaction });
    assert.ok(event, 'devolução gera evento próprio (Caderno §13)');
  });
});

test('F04-1b: o vínculo com a origem e o titular são imutáveis no BANCO — UPDATE cru é recusado pelo trigger', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, holder } = await createLeaseWithTenantParty(transaction);
    const deposit = await receiveDeposit(transaction, { contract, holder, amount: 2000 });
    const otherDeposit = await receiveDeposit(transaction, { contract, holder, amount: 900 });
    const release = await releaseDeposit(transaction, { amount: 300, thirdPartyOriginEntryId: deposit.id });

    // Cada tentativa proibida aborta a transação no Postgres: SAVEPOINT por tentativa.
    for (const [column, value] of [
      ['third_party_origin_entry_id', otherDeposit.id],
      ['third_party_holder_person_id', null],
    ]) {
      await sequelize.query('SAVEPOINT f04_1b', { transaction });
      await assert.rejects(
        () => sequelize.query(`UPDATE finance.financial_entries SET "${column}" = :value WHERE id = :id`, {
          replacements: { value, id: release.id },
          transaction,
        }),
        new RegExp(`append-only.*${column}`),
        `${column} não pode ser reescrita por SQL direto`
      );
      await sequelize.query('ROLLBACK TO SAVEPOINT f04_1b', { transaction });
    }

    const [[row]] = await sequelize.query(
      'SELECT third_party_origin_entry_id AS origin, third_party_holder_person_id AS holder FROM finance.financial_entries WHERE id = :id',
      { replacements: { id: release.id }, transaction }
    );
    assert.equal(row.origin, deposit.id);
    assert.equal(row.holder, holder.id);
  });
});

test('F04-2: negativos — sem origem, origem inexistente, contrato divergente, titular divergente e valor acima do saldo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, holder } = await createLeaseWithTenantParty(transaction);
    const other = await createLeaseWithTenantParty(transaction);
    const deposit = await receiveDeposit(transaction, { contract, holder, amount: 1000 });

    await expectCode(releaseDeposit(transaction, { amount: 100 }), 'FINANCE_THIRD_PARTY_ORIGIN_REQUIRED');
    await expectCode(
      releaseDeposit(transaction, { amount: 100, thirdPartyOriginEntryId: '00000000-0000-4000-8000-000000000000' }),
      'FINANCE_THIRD_PARTY_ORIGIN_NOT_FOUND'
    );
    await expectCode(
      releaseDeposit(transaction, { amount: 100, thirdPartyOriginEntryId: deposit.id, contractId: other.contract.id }),
      'FINANCE_THIRD_PARTY_CONTRACT_MISMATCH'
    );
    await expectCode(
      releaseDeposit(transaction, { amount: 100, thirdPartyOriginEntryId: deposit.id, thirdPartyHolderPersonId: other.holder.id }),
      'FINANCE_THIRD_PARTY_HOLDER_MISMATCH'
    );
    await expectCode(
      releaseDeposit(transaction, { amount: 1000.01, thirdPartyOriginEntryId: deposit.id }),
      'FINANCE_THIRD_PARTY_RELEASE_EXCEEDS_BALANCE'
    );
    const balance = await financialEntriesService.computeThirdPartyOriginBalance(deposit.id, transaction);
    assert.equal(balance.available, '1000.00', 'nenhuma saída inválida consumiu saldo');
  });
});

test('F04-3: origem que não é caução recebida (não recebida, ou sem contrato/titular) não pode ser devolvida', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract, holder } = await createLeaseWithTenantParty(transaction);
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const notReceived = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 300, description: 'CONF1810 caução a receber', resultCenterId: resultCenter.id, contractId: contract.id, isThirdPartyFunds: true, thirdPartyReference: 'Caução', thirdPartyHolderPersonId: holder.id }),
      tenant.userId,
      transaction
    );
    await expectCode(releaseDeposit(transaction, { amount: 100, thirdPartyOriginEntryId: notReceived.id }), 'FINANCE_THIRD_PARTY_ORIGIN_NOT_RECEIVED');

    const untraceable = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 300, description: 'CONF1810 terceiro sem vínculo', resultCenterId: resultCenter.id, isThirdPartyFunds: true, thirdPartyReference: 'Valor de terceiro' }),
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(untraceable.id, tenant.userId, transaction);
    await expectCode(releaseDeposit(transaction, { amount: 100, thirdPartyOriginEntryId: untraceable.id }), 'FINANCE_THIRD_PARTY_ORIGIN_UNTRACEABLE');

    const ownRevenue = await financialEntriesService.createFinancialEntry(
      withTenant({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 300, description: 'CONF1810 receita própria', resultCenterId: resultCenter.id }),
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(ownRevenue.id, tenant.userId, transaction);
    await expectCode(releaseDeposit(transaction, { amount: 100, thirdPartyOriginEntryId: ownRevenue.id }), 'FINANCE_THIRD_PARTY_ORIGIN_INVALID');
  });
});

test('F04-4: no recebimento, o titular precisa ser parte do contrato', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithTenantParty(transaction);
    const stranger = await Person.create(
      withTenant({ personType: 'PF', legalName: `CONF1810 Estranho ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId }),
      { transaction }
    );
    const resultCenter = await createTestResultCenter(tenant, transaction);
    await expectCode(
      financialEntriesService.createFinancialEntry(
        withTenant({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 500, description: 'CONF1810 caução', resultCenterId: resultCenter.id, contractId: contract.id, isThirdPartyFunds: true, thirdPartyReference: 'Caução', thirdPartyHolderPersonId: stranger.id }),
        tenant.userId,
        transaction
      ),
      'FINANCE_THIRD_PARTY_HOLDER_NOT_CONTRACT_PARTY'
    );
  });
});

test('F04-5 (HTTP): POST /finance/entries recusa devolução de caução sem origem e aceita a vinculada', async () => {
  const { depositId, costCenterId } = await withCommitted(async (t) => {
    const { contract, holder } = await createLeaseWithTenantParty(t);
    const deposit = await receiveDeposit(t, { contract, holder, amount: 750 });
    const costCenter = await createTestCostCenter(tenant, t);
    return { depositId: deposit.id, costCenterId: costCenter.id };
  });
  const token = tokenFor(tenant.userId, ['finance:read', 'finance:create']);
  const base = { entryType: 'DEBIT', nature: 'PAYABLE', description: 'CONF1810 HTTP devolução', costCenterId, isThirdPartyFunds: true, thirdPartyReference: 'Devolução de caução' };

  const loose = await http('POST', '/finance/entries', token, { ...base, amount: 100 });
  assert.equal(loose.status, 400, JSON.stringify(loose.body));
  assert.equal(loose.body.error.code, 'FINANCE_THIRD_PARTY_ORIGIN_REQUIRED');

  const tooMuch = await http('POST', '/finance/entries', token, { ...base, amount: 750.01, thirdPartyOriginEntryId: depositId });
  assert.equal(tooMuch.status, 409);
  assert.equal(tooMuch.body.error.code, 'FINANCE_THIRD_PARTY_RELEASE_EXCEEDS_BALANCE');

  const linked = await http('POST', '/finance/entries', token, { ...base, amount: 750, thirdPartyOriginEntryId: depositId });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  assert.equal(linked.body.data.thirdPartyOriginEntryId, depositId);
});
