'use strict';

// M45 (19/10/2026) — cruzamento do Caderno do Marco 4 linha a linha (Maturacao/MARCO_4_CADERNO_
// COMPLETO.md). Cada teste cobre uma linha do caderno que não tinha prova direta na suíte:
//   - Guia §14 "Eventos mínimos" com os nomes literais (payment.prepared/approved/completed/
//     reversed, receipt.completed, reconciliation.completed, owner_repass.completed, anomaly.opened);
//   - §12 "Desconto precisa de motivo/documento/regra" (repasse com dedução exige motivo);
//   - §4 "contas analíticas e sintéticas" (conta com subcontas não recebe lançamento);
//   - §4 "Centro de custo obrigatório para despesa / de resultado para receita";
//   - §17 "Exportação financeira massiva → MFA + auditoria + limite" (serviço e rota HTTP real);
//   - §5 "Entidades/tabelas obrigatórias" (nomes do caderno no banco, somente leitura, com RLS);
//   - FIN-008 "Moeda usa numeric/decimal" (catálogo: nenhuma coluna monetária float).
// Tudo em transação com ROLLBACK, exceto o usuário MFA do teste HTTP (banco descartável do CI /
// scripts/reproduzir-conferencia.sh).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M45_M4_GAPS_HTTP_TEST_PORT || '21655';

require('../app');
const {
  sequelize,
  getSeedTenant,
  withTenantTransaction,
  withRollbackTenantTransaction,
  uniqueSuffix,
  createTestCostCenter,
  createTestResultCenter,
  createManualSettlementEvidence,
  approveFinancialEntryForSettlement,
} = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { encryptSecret } = require('../src/utils/mfaCrypto');
const { User, BankAccount, Person, Property, OutboxEvent, MfaCredential, MfaStepUp, AuditLog } = require('../src/models');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const paymentIntentsService = require('../src/features/finance/paymentIntents.service');
const bankTransactionsService = require('../src/features/finance/bankTransactions.service');
const reconciliationService = require('../src/features/finance/reconciliation.service');
const anomalyCasesService = require('../src/features/finance/anomalyCases.service');
const ownerRepassesService = require('../src/features/finance/ownerRepasses.service');
const chartOfAccountsService = require('../src/features/finance/chartOfAccounts.service');
const { exportFinancialEntries } = require('../src/features/finance/financeExport.service');

let tenant;
let baseUrl;
let mfaUser;

const T = (fields) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields });

async function expectCode(fn, code) {
  await assert.rejects(fn, (err) => {
    assert.equal(err.code, code, `esperado ${code}, veio ${err.code}: ${err.message}`);
    return true;
  });
}

async function eventTypesFor(aggregateId, transaction) {
  const rows = await OutboxEvent.findAll({ where: { aggregateId }, transaction });
  return rows.map((r) => r.eventType);
}

async function newUser(transaction, label) {
  return User.create(
    { email: `m45-m4-${label}-${uniqueSuffix()}@nayaraone.dev`, name: `M45 M4 ${label}`, passwordHash: 'x', status: 'ACTIVE' },
    { transaction }
  );
}

async function newBankAccount(transaction) {
  return BankAccount.create(T({ bankCode: '001', agency: '0001', accountNumber: `M45M4-${uniqueSuffix()}`, status: 'ACTIVE' }), { transaction });
}

before(async () => {
  tenant = await getSeedTenant();
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  mfaUser = await User.create(
    { email: `m45-m4-mfa-${uniqueSuffix()}@nayaraone.dev`, name: 'M45 M4 MFA', passwordHash: 'x', status: 'ACTIVE', mfaEnabled: true, mfaMethod: 'TOTP' }
  );
  await withTenantTransaction(tenant, async (t) => {
    await MfaCredential.create(T({ userId: mfaUser.id, secretEncrypted: encryptSecret('JBSWY3DPEHPK3PXP'), enabled: true, confirmedAt: new Date(), recoveryCodesHash: [] }), { transaction: t });
    await MfaStepUp.create(T({ userId: mfaUser.id, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60 * 1000) }), { transaction: t });
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

function tokenFor(userId, permissions) {
  return signAccessToken({ sub: userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions });
}

test('M45-M4-01 eventos mínimos do Guia §14 com o nome literal: payment.prepared/approved/completed/reversed, receipt.completed, reconciliation.completed, anomaly.opened', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    // Pagamento: intenção -> aprovação por outra pessoa -> execução (baixa manual com comprovante).
    const cc = await createTestCostCenter(tenant, t);
    const payable = await financialEntriesService.createFinancialEntry(
      T({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 12.34, description: `M45-M4-01 pagar ${uniqueSuffix()}`, costCenterId: cc.id }), tenant.userId, t
    );
    const manualSettlement = await createManualSettlementEvidence(tenant, tenant.userId, t);
    await financialEntriesService.attachSettlementEvidence(payable.id, manualSettlement, tenant.userId, t);
    const intent = await paymentIntentsService.createPaymentIntent({ financialEntryId: payable.id }, tenant.userId, t);
    assert.ok((await eventTypesFor(intent.id, t)).includes('finance.payment.prepared'));
    const approver = await newUser(t, 'aprovador');
    await paymentIntentsService.approvePaymentIntent(intent.id, approver.id, t);
    assert.ok((await eventTypesFor(intent.id, t)).includes('finance.payment.approved'));
    await paymentIntentsService.executePaymentIntent(intent.id, approver.id, t, { manualSettlement });
    const payableEvents = await eventTypesFor(payable.id, t);
    assert.ok(payableEvents.includes('finance.payment.completed'), payableEvents.join(','));
    assert.ok(!payableEvents.includes('finance.receipt.completed'));

    await financialEntriesService.reverseFinancialEntry(payable.id, 'M45-M4-01 estorno de teste', tenant.userId, t);
    assert.ok((await eventTypesFor(payable.id, t)).includes('finance.payment.reversed'));

    // Recebimento com conta: receipt.completed; conciliação com o extrato: reconciliation.completed.
    const bank = await newBankAccount(t);
    const rc = await createTestResultCenter(tenant, t);
    const receivable = await financialEntriesService.createFinancialEntry(
      T({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 45.6, description: `M45-M4-01 receber ${uniqueSuffix()}`, resultCenterId: rc.id, bankAccountId: bank.id }), tenant.userId, t
    );
    await financialEntriesService.settleFinancialEntry(receivable.id, tenant.userId, t);
    assert.ok((await eventTypesFor(receivable.id, t)).includes('finance.receipt.completed'));
    const bankTx = await bankTransactionsService.createBankTransaction(
      T({ bankAccountId: bank.id, externalTransactionId: `M45M4-${uniqueSuffix()}`, amount: 45.6, transactionDate: new Date(), description: 'M45-M4-01 extrato' }), tenant.userId, t
    );
    const reconciliation = await reconciliationService.matchReconciliation(T({ financialEntryId: receivable.id, bankTransactionId: bankTx.id }), tenant.userId, t);
    assert.ok((await eventTypesFor(reconciliation.id, t)).includes('finance.reconciliation.completed'));

    const anomaly = await anomalyCasesService.createAnomalyCase(T({ caseType: 'M45_TEST', riskLevel: 'HIGH', reason: 'M45-M4-01 anomalia de teste' }), tenant.userId, t);
    assert.ok((await eventTypesFor(anomaly.id, t)).includes('finance.anomaly.opened'));
  });
});

async function repasseSetup(t) {
  const suffix = uniqueSuffix();
  const owner = await Person.create(T({ personType: 'PF', legalName: `Proprietário M45M4 ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId }), { transaction: t });
  const property = await Property.create(T({ title: `Imóvel M45M4 ${suffix}`, internalCode: `M45M4-${suffix}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }), { transaction: t });
  const rc = await createTestResultCenter(tenant, t);
  const received = await financialEntriesService.createFinancialEntry(
    T({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 1000, resultCenterId: rc.id, description: `M45-M4 aluguel ${suffix}` }), tenant.userId, t
  );
  await financialEntriesService.settleFinancialEntry(received.id, tenant.userId, t);
  const bank = await newBankAccount(t);
  const costCenter = await createTestCostCenter(tenant, t);
  const base = T({ propertyId: property.id, ownerPersonId: owner.id, bankAccountId: bank.id, sourceEntryIds: [received.id], grossAmount: 1000, deductionsAmount: 100, referenceMonth: '2026-09' });
  return { base, costCenter };
}

test('M45-M4-02 repasse: dedução sem motivo é recusada (serviço e CHECK no banco); com motivo grava, e o pagamento publica finance.owner_repass.completed', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { base, costCenter } = await repasseSetup(t);
    await expectCode(() => ownerRepassesService.createOwnerRepasse(base, tenant.userId, t), 'FINANCE_OWNER_REPASSE_DEDUCTION_REASON_REQUIRED');
    await expectCode(() => ownerRepassesService.createOwnerRepasse({ ...base, deductionsReason: '   ' }, tenant.userId, t), 'FINANCE_OWNER_REPASSE_DEDUCTION_REASON_REQUIRED');
    // Sem dedução, o motivo não é exigido.
    await sequelize.query('SAVEPOINT sem_deducao', { transaction: t });
    const semDeducao = await ownerRepassesService.createOwnerRepasse({ ...base, deductionsAmount: 0 }, tenant.userId, t);
    assert.equal(Number(semDeducao.deductionsAmount), 0);
    await sequelize.query('ROLLBACK TO SAVEPOINT sem_deducao', { transaction: t });

    const repasse = await ownerRepassesService.createOwnerRepasse({ ...base, deductionsReason: 'Taxa de administração (10%)' }, tenant.userId, t);
    assert.equal(repasse.deductionsReason, 'Taxa de administração (10%)');
    assert.equal(Number(repasse.netAmount), 900);

    await sequelize.query('SAVEPOINT chk', { transaction: t });
    await assert.rejects(
      () => sequelize.query('UPDATE finance.owner_repasses SET deductions_reason = NULL WHERE id = :id', { replacements: { id: repasse.id }, transaction: t }),
      (err) => /owner_repasses_deduction_reason_chk/.test(String(err.message))
    );
    await sequelize.query('ROLLBACK TO SAVEPOINT chk', { transaction: t });

    const checker = await newUser(t, 'checker');
    const { financialEntry } = await ownerRepassesService.approveOwnerRepasse(repasse.id, { costCenterId: costCenter.id }, checker.id, t);
    const manualSettlement = await createManualSettlementEvidence(tenant, tenant.userId, t);
    await financialEntriesService.attachSettlementEvidence(financialEntry.id, manualSettlement, tenant.userId, t);
    await approveFinancialEntryForSettlement(tenant, financialEntry.id, tenant.userId, t);
    await financialEntriesService.settleFinancialEntry(financialEntry.id, tenant.userId, t, { manualSettlement });
    const paid = await ownerRepassesService.payOwnerRepasse(repasse.id, tenant.userId, t);
    assert.equal(paid.status, 'PAID');
    assert.ok((await eventTypesFor(repasse.id, t)).includes('finance.owner_repass.completed'));
  });
});

test('M45-M4-03 plano de contas: conta SINTÉTICA (com subconta ativa) não recebe lançamento; a ANALÍTICA recebe', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const s = uniqueSuffix();
    const synthetic = await chartOfAccountsService.createAccount(T({ code: `9-${s}`, name: 'Receitas M45 (sintética)', accountType: 'REVENUE' }), tenant.userId, t);
    const analytic = await chartOfAccountsService.createAccount(T({ code: `9.1-${s}`, name: 'Aluguel M45 (analítica)', accountType: 'REVENUE', parentAccountId: synthetic.id }), tenant.userId, t);
    const rc = await createTestResultCenter(tenant, t);
    const entry = (chartOfAccountId) => financialEntriesService.createFinancialEntry(
      T({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 10, resultCenterId: rc.id, chartOfAccountId, description: `M45-M4-03 ${uniqueSuffix()}` }), tenant.userId, t
    );
    await expectCode(() => entry(synthetic.id), 'FINANCE_CHART_ACCOUNT_SYNTHETIC');
    const ok = await entry(analytic.id);
    assert.equal(ok.chartOfAccountId, analytic.id);
  });
});

test('M45-M4-04 dimensões obrigatórias: despesa sem centro de custo e receita sem centro de resultado são recusadas na criação', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await expectCode(
      () => financialEntriesService.createFinancialEntry(T({ entryType: 'DEBIT', nature: 'PAYABLE', amount: 10, description: 'M45-M4-04 sem centro de custo' }), tenant.userId, t),
      'FINANCE_ENTRY_COST_CENTER_REQUIRED'
    );
    await expectCode(
      () => financialEntriesService.createFinancialEntry(T({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 10, description: 'M45-M4-04 sem centro de resultado' }), tenant.userId, t),
      'FINANCE_ENTRY_RESULT_CENTER_REQUIRED'
    );
  });
});

test('M45-M4-05 exportação financeira: acima do limite é recusada inteira (nunca truncada); dentro do limite gera CSV e grava auditoria com hash', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const rc = await createTestResultCenter(tenant, t);
    const month = `19${String(10 + Math.floor(Math.random() * 80)).padStart(2, '0')}-0${1 + Math.floor(Math.random() * 9)}`;
    for (const amount of [10, 20]) {
      await financialEntriesService.createFinancialEntry(
        T({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount, resultCenterId: rc.id, competenceMonth: month, description: `M45-M4-05 ${uniqueSuffix()}` }), tenant.userId, t
      );
    }
    const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
    await expectCode(() => exportFinancialEntries(ctx, { competenceMonth: month }, t, { maxRows: 1 }), 'FINANCE_EXPORT_LIMIT_EXCEEDED');
    await expectCode(() => exportFinancialEntries(ctx, { competenceMonth: '2026-13x' }, t), 'FINANCE_EXPORT_VALIDATION');
    const result = await exportFinancialEntries(ctx, { competenceMonth: month }, t, { maxRows: 2 });
    assert.equal(result.rows, 2);
    assert.equal(result.csv.trim().split('\n').length, 3, 'cabeçalho + 2 linhas');
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    const audit = await AuditLog.findOne({ where: { action: 'finance.entries.export', userId: tenant.userId }, order: [['occurred_at', 'DESC']], transaction: t });
    assert.ok(audit, 'exportação auditada');
    assert.equal(audit.afterJson.rows, 2);
    assert.equal(audit.afterJson.sha256, result.sha256);
  });
});

test('M45-M4-06 exportação financeira via HTTP real: sem finance:read 403, sem MFA 403 MFA_REQUIRED_NOT_ENABLED, MFA sem verificação recente 403 MFA_STEP_UP_REQUIRED, com MFA recente 200 text/csv', async () => {
  const month = '1901-01';
  const call = async (token) => fetch(`${baseUrl}/finance/exports/entries?competenceMonth=${month}`, { headers: { Authorization: `Bearer ${token}` } });

  const noPerm = await call(tokenFor(mfaUser.id, ['legal:read']));
  assert.equal(noPerm.status, 403);

  const noMfaUser = await User.create({ email: `m45-m4-nomfa-${uniqueSuffix()}@nayaraone.dev`, name: 'M45 M4 sem MFA', passwordHash: 'x', status: 'ACTIVE' });
  const noMfa = await call(tokenFor(noMfaUser.id, ['finance:read']));
  assert.equal(noMfa.status, 403);
  const noMfaBody = await noMfa.json();
  assert.equal(noMfaBody.error.code, 'MFA_REQUIRED_NOT_ENABLED');

  // MFA habilitado, mas sem verificação recente (step-up): recusado com MFA_STEP_UP_REQUIRED.
  const staleUser = await User.create({ email: `m45-m4-stale-${uniqueSuffix()}@nayaraone.dev`, name: 'M45 M4 MFA sem step-up', passwordHash: 'x', status: 'ACTIVE', mfaEnabled: true, mfaMethod: 'TOTP' });
  await withTenantTransaction(tenant, (t) => MfaCredential.create(T({ userId: staleUser.id, secretEncrypted: encryptSecret('JBSWY3DPEHPK3PXP'), enabled: true, confirmedAt: new Date(), recoveryCodesHash: [] }), { transaction: t }));
  const stale = await call(tokenFor(staleUser.id, ['finance:read']));
  assert.equal(stale.status, 403);
  assert.equal((await stale.json()).error.code, 'MFA_STEP_UP_REQUIRED');

  const ok = await call(tokenFor(mfaUser.id, ['finance:read']));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/csv/);
  assert.match(ok.headers.get('x-export-sha256'), /^[0-9a-f]{64}$/);
  const body = await ok.text();
  assert.ok(body.startsWith('id;competenceMonth;nature'), body.slice(0, 60));
});

test('M45-M4-07 §5 tabelas do caderno: ledger, entry_installments, security_deposits, accounts_chart e closing_periods existem, seguem a RLS e são somente leitura', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const [[catalog]] = await sequelize.query(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'finance' AND c.relname IN ('ledger','entry_installments','security_deposits','accounts_chart','closing_periods')
          AND c.relkind = 'v' AND 'security_invoker=true' = ANY(c.reloptions)`,
      { transaction: t }
    );
    assert.equal(catalog.n, 5);
    const rc = await createTestResultCenter(tenant, t);
    const bank = await newBankAccount(t);
    const entry = await financialEntriesService.createFinancialEntry(
      T({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 77.7, resultCenterId: rc.id, bankAccountId: bank.id, description: `M45-M4-07 ${uniqueSuffix()}` }), tenant.userId, t
    );
    const [[before]] = await sequelize.query('SELECT count(*)::int AS n FROM finance.ledger WHERE id = :id', { replacements: { id: entry.id }, transaction: t });
    assert.equal(before.n, 0, 'previsto não é ledger');
    await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, t);
    const [[row]] = await sequelize.query('SELECT direction, amount::text AS amount, movement_type FROM finance.ledger WHERE id = :id', { replacements: { id: entry.id }, transaction: t });
    assert.deepEqual(row, { direction: 'CREDIT', amount: '77.70', movement_type: 'RECEIVABLE' });

    await sequelize.query('SAVEPOINT ro', { transaction: t });
    await assert.rejects(
      () => sequelize.query('DELETE FROM finance.ledger WHERE id = :id', { replacements: { id: entry.id }, transaction: t }),
      (err) => /somente leitura/.test(String(err.message))
    );
    await sequelize.query('ROLLBACK TO SAVEPOINT ro', { transaction: t });

    // RLS pela view: com o contexto de OUTRA empresa, o lançamento não aparece.
    await sequelize.query("SELECT set_config('app.company_id', :other, true)", { replacements: { other: '00000000-0000-4000-8000-0000000000aa' }, transaction: t });
    const [[other]] = await sequelize.query('SELECT count(*)::int AS n FROM finance.ledger WHERE id = :id', { replacements: { id: entry.id }, transaction: t });
    assert.equal(other.n, 0);
  });
});

test('M45-M4-08 FIN-008: nenhuma coluna de dinheiro do schema finance usa float/real/double — moeda é numeric', async () => {
  const [rows] = await sequelize.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'finance' AND data_type IN ('real', 'double precision')`
  );
  assert.deepEqual(rows, []);
  const [[amount]] = await sequelize.query(
    `SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns
      WHERE table_schema = 'finance' AND table_name = 'financial_entries' AND column_name = 'amount'`
  );
  assert.deepEqual(amount, { data_type: 'numeric', numeric_precision: 18, numeric_scale: 2 });
});
