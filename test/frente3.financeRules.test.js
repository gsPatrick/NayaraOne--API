'use strict';

// Frente 3 — Regras do Financeiro (Marco 4). Caderno §4, §12, §14, §15 + revisão independente
// 18/10/2026 (itens 4, 5, 12, 13). Tudo contra o Postgres de homologação pelo usuário de runtime
// (RLS FORCE), dentro de transações que SEMPRE fazem rollback (nada fica gravado).

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const {
  sequelize,
  getSeedTenant,
  withRollbackTenantTransaction,
  uniqueSuffix,
  createTestCostCenter,
  createTestResultCenter,
} = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const intercompanyService = require('../src/features/finance/intercompanyTransfers.service');
const commissionsService = require('../src/features/finance/commissions.service');
const ownerRepassesService = require('../src/features/finance/ownerRepasses.service');
const chartService = require('../src/features/finance/chartOfAccounts.service');
const approvalsService = require('../src/features/finance/approvals.service');
const filesService = require('../src/features/files/files.service');
const {
  Company,
  BankAccount,
  FinancialEntry,
  User,
  UserMembership,
  Person,
  Property,
  OwnerRepass,
  AuditLog,
  ChartOfAccountVersion,
  Commission,
} = require('../src/models');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});

// ------------------------------------------------------------------ helpers locais
async function setCompany(transaction, companyId) {
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: companyId }, transaction });
}

async function inCompany(transaction, companyId, fn) {
  await setCompany(transaction, companyId);
  try {
    return await fn();
  } finally {
    await setCompany(transaction, tenant.companyId);
  }
}

async function newUser(transaction, label) {
  const suffix = uniqueSuffix();
  return User.create(
    { email: `frente3-${label}-${suffix}@nayaraone.dev`, name: `Frente3 ${label} ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
    { transaction }
  );
}

async function newBankAccount(transaction, companyId = tenant.companyId) {
  return BankAccount.create(
    { groupId: tenant.groupId, companyId, bankCode: '001', agency: '0001', accountNumber: `F3-${uniqueSuffix()}`, status: 'ACTIVE' },
    { transaction }
  );
}

async function newFile(transaction, companyId = tenant.companyId) {
  return filesService.uploadFile(
    {
      groupId: tenant.groupId,
      companyId,
      fileName: 'documento-frente3.pdf',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from(`DOC FRENTE 3 ${uniqueSuffix()}`).toString('base64'),
      category: 'generic',
    },
    tenant.userId,
    transaction
  );
}

async function newReceivable(transaction, amount, extra = {}) {
  const rc = await createTestResultCenter(tenant, transaction);
  return financialEntriesService.createFinancialEntry(
    { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount, resultCenterId: rc.id, description: `F3 receber ${uniqueSuffix()}`, ...extra },
    tenant.userId,
    transaction
  );
}

// Liquida um PAYABLE pelo caminho formal: comprovante anexado -> aprovação de OUTRA pessoa -> baixa manual.
async function settlePayableWithEvidence(transaction, entryId) {
  const file = await newFile(transaction);
  const manualSettlement = { evidenceFileId: file.id, reason: 'Pagamento feito fora da integração — comprovante anexado (teste frente 3).' };
  await financialEntriesService.attachSettlementEvidence(entryId, manualSettlement, tenant.userId, transaction);
  const approver = await newUser(transaction, 'aprovador-baixa');
  const request = await approvalsService.createApprovalRequest(
    { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: entryId, riskLevel: 'LOW' },
    tenant.userId,
    transaction
  );
  await approvalsService.decideApprovalStep(request.id, { decision: 'APPROVED' }, approver.id, transaction);
  const settled = await financialEntriesService.settleFinancialEntry(entryId, tenant.userId, transaction, { manualSettlement });
  return { settled, file };
}

async function newSettledPayable(transaction, amount) {
  const cc = await createTestCostCenter(tenant, transaction);
  const entry = await financialEntriesService.createFinancialEntry(
    { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount, costCenterId: cc.id, description: `F3 pagar ${uniqueSuffix()}` },
    tenant.userId,
    transaction
  );
  return (await settlePayableWithEvidence(transaction, entry.id)).settled;
}

async function expectCode(promiseFn, code) {
  await assert.rejects(promiseFn, (err) => {
    assert.equal(err.code, code, `esperado ${code}, veio ${err.code}: ${err.message}`);
    return true;
  });
}

// Executa SQL numa SAVEPOINT e devolve o erro do banco (ou null), sem abortar a transação externa.
async function sqlError(transaction, sql, replacements = {}) {
  try {
    await sequelize.transaction({ transaction }, (sp) => sequelize.query(sql, { replacements, transaction: sp }));
    return null;
  } catch (err) {
    return err;
  }
}

async function intercompanySetup(transaction) {
  const suffix = uniqueSuffix();
  const destination = await Company.create({ groupId: tenant.groupId, name: `F3 Destino ${suffix}`, status: 'ACTIVE' }, { transaction });
  const fromAccount = await newBankAccount(transaction);
  const toAccount = await inCompany(transaction, destination.id, () => newBankAccount(transaction, destination.id));
  const evidence = await newFile(transaction);
  const base = {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    toCompanyId: destination.id,
    amount: 1234.56,
    reason: `Aporte de caixa ${suffix}`,
    evidenceFileId: evidence.id,
    fromBankAccountId: fromAccount.id,
    toBankAccountId: toAccount.id,
  };
  return { destination, base };
}

// ==================================================================================
// §15 Intercompany
// ==================================================================================

test('F3-IC1 motivo, documento e contas correspondentes são obrigatórios', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { base } = await intercompanySetup(t);
    await expectCode(() => intercompanyService.createIntercompanyTransfer({ ...base, reason: '   ' }, tenant.userId, t), 'FINANCE_INTERCOMPANY_REASON_REQUIRED');
    await expectCode(() => intercompanyService.createIntercompanyTransfer({ ...base, evidenceFileId: undefined }, tenant.userId, t), 'FINANCE_INTERCOMPANY_EVIDENCE_REQUIRED');
    await expectCode(
      () => intercompanyService.createIntercompanyTransfer({ ...base, evidenceFileId: '00000000-0000-4000-8000-000000000000' }, tenant.userId, t),
      'FINANCE_INTERCOMPANY_EVIDENCE_NOT_FOUND'
    );
    await expectCode(() => intercompanyService.createIntercompanyTransfer({ ...base, toBankAccountId: undefined }, tenant.userId, t), 'FINANCE_INTERCOMPANY_BANK_ACCOUNTS_REQUIRED');
    // Conta "do destino" que na verdade é da origem: recusada.
    await expectCode(
      () => intercompanyService.createIntercompanyTransfer({ ...base, toBankAccountId: base.fromBankAccountId }, tenant.userId, t),
      'FINANCE_INTERCOMPANY_BANK_ACCOUNT_INVALID'
    );
  });
});

test('F3-IC2 pedido nasce sem lançamentos; quem pede não aprova; outra pessoa aprova e cria os dois lados', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { destination, base } = await intercompanySetup(t);
    const { transfer } = await intercompanyService.createIntercompanyTransfer(base, tenant.userId, t);
    assert.equal(transfer.status, 'PENDING_APPROVAL');
    assert.equal(transfer.fromEntryId, null);
    assert.equal(transfer.toEntryId, null);
    assert.equal(transfer.requestedByUserId, tenant.userId);
    const legs = await FinancialEntry.count({ where: { idempotencyKey: [`intercompany-transfer:${transfer.id}:from`] }, transaction: t });
    assert.equal(legs, 0, 'nada se move antes da aprovação');

    await expectCode(() => intercompanyService.reconcileIntercompanyTransfer(transfer.id, tenant.userId, t), 'FINANCE_INTERCOMPANY_INVALID_STATUS');
    await expectCode(() => intercompanyService.approveIntercompanyTransfer(transfer.id, {}, tenant.userId, t), 'FINANCE_INTERCOMPANY_SELF_APPROVAL_FORBIDDEN');

    const checker = await newUser(t, 'checker-ic');
    const { transfer: approved, fromEntry, toEntry } = await intercompanyService.approveIntercompanyTransfer(transfer.id, {}, checker.id, t);
    assert.equal(approved.status, 'PENDING');
    assert.equal(approved.approvedByUserId, checker.id);
    assert.equal(fromEntry.bankAccountId, base.fromBankAccountId);
    assert.equal(fromEntry.entryType, 'DEBIT');
    assert.equal(Number(fromEntry.amount), 1234.56);
    const toPersisted = await inCompany(t, destination.id, () => FinancialEntry.findByPk(toEntry.id, { transaction: t }));
    assert.equal(toPersisted.companyId, destination.id);
    assert.equal(toPersisted.bankAccountId, base.toBankAccountId);
    assert.equal(toPersisted.entryType, 'CREDIT');

    await expectCode(() => intercompanyService.approveIntercompanyTransfer(transfer.id, {}, checker.id, t), 'FINANCE_INTERCOMPANY_INVALID_STATUS');

    // Recusa: outro pedido, recusado com motivo, sem lançamentos.
    const { transfer: second } = await intercompanyService.createIntercompanyTransfer({ ...base, reason: 'Segundo pedido' }, tenant.userId, t);
    await expectCode(() => intercompanyService.rejectIntercompanyTransfer(second.id, {}, checker.id, t), 'FINANCE_INTERCOMPANY_REJECTION_REASON_REQUIRED');
    const rejected = await intercompanyService.rejectIntercompanyTransfer(second.id, { reason: 'Sem lastro' }, checker.id, t);
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.fromEntryId, null);
  });
});

test('F3-IC3 o banco recusa aprovador = solicitante e pedido sem motivo/documento (CHECK)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { base } = await intercompanySetup(t);
    const { transfer } = await intercompanyService.createIntercompanyTransfer(base, tenant.userId, t);
    const selfApproval = await sqlError(
      t,
      'UPDATE finance.intercompany_transfers SET approved_by_user_id = requested_by_user_id WHERE id = :id',
      { id: transfer.id }
    );
    assert.ok(selfApproval && /intercompany_transfers_maker_checker_ck/.test(selfApproval.message), String(selfApproval && selfApproval.message));
    const noReason = await sqlError(t, 'UPDATE finance.intercompany_transfers SET reason = NULL WHERE id = :id', { id: transfer.id });
    assert.ok(noReason && /intercompany_transfers_formal_requirements_ck/.test(noReason.message), String(noReason && noReason.message));
    const noDoc = await sqlError(t, 'UPDATE finance.intercompany_transfers SET evidence_file_id = NULL WHERE id = :id', { id: transfer.id });
    assert.ok(noDoc && /intercompany_transfers_formal_requirements_ck/.test(noDoc.message));
  });
});

test('F3-IC4 consolidado do grupo elimina os dois lados da transferência (sem duplicidade) e só onde o usuário tem permissão', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { destination, base } = await intercompanySetup(t);
    const actor = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };

    // Sem vínculo com a empresa de destino: ela fica fora e nada é eliminado.
    const { transfer } = await intercompanyService.createIntercompanyTransfer(base, tenant.userId, t);
    const checker = await newUser(t, 'checker-cons');
    await intercompanyService.approveIntercompanyTransfer(transfer.id, {}, checker.id, t);
    const withoutDest = await intercompanyService.getGroupConsolidatedReport(actor, {}, t);
    assert.ok(withoutDest.excludedCompanies.some((c) => c.companyId === destination.id));
    assert.ok(!withoutDest.eliminations.some((e) => e.transferId === transfer.id), 'sem as duas pontas no relatório não há o que eliminar');

    // Dá ao usuário a mesma role (com finance:read) também no destino.
    // M45 F8: a tela recebe o indicador por empresa em vez de contas vazias.
    let dests = await intercompanyService.listDestinationCompanies(actor, t);
    assert.equal(dests.find((c) => c.id === destination.id).canReadFinance, false);
    assert.ok(!dests.some((c) => c.id === tenant.companyId), 'a empresa atual não é destino');
    const membership = await UserMembership.findOne({ where: { userId: tenant.userId, companyId: tenant.companyId, status: 'ACTIVE' }, transaction: t });
    await inCompany(t, destination.id, () =>
      UserMembership.create({ groupId: tenant.groupId, companyId: destination.id, userId: tenant.userId, roleId: membership.roleId, status: 'ACTIVE' }, { transaction: t })
    );
    const report = await intercompanyService.getGroupConsolidatedReport(actor, {}, t);
    const elimination = report.eliminations.find((e) => e.transferId === transfer.id);
    assert.ok(elimination, 'transferência aprovada entre duas empresas do relatório é eliminada');
    assert.equal(elimination.amount, 1234.56);
    const destRow = report.companies.find((c) => c.companyId === destination.id);
    assert.equal(destRow.totalCredits, 1234.56, 'a empresa de destino continua mostrando a entrada na visão individual');
    assert.equal(destRow.intercompanyCredits, 1234.56);
    // O consolidado = soma das empresas MENOS os dois lados eliminados (uma vez cada, não duas).
    const sumCredits = report.companies.reduce((a, c) => a + Math.round(c.totalCredits * 100), 0);
    const sumDebits = report.companies.reduce((a, c) => a + Math.round(c.totalDebits * 100), 0);
    const elimCents = report.eliminations.reduce((a, e) => a + Math.round(e.amount * 100), 0);
    assert.equal(Math.round(report.consolidated.totalCredits * 100), sumCredits - elimCents);
    assert.equal(Math.round(report.consolidated.totalDebits * 100), sumDebits - elimCents);
  });
});

test('F3-IC5 contas do destino só são listadas com finance:read no destino (RLS continua valendo)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { destination, base } = await intercompanySetup(t);
    const actor = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
    await expectCode(() => intercompanyService.listDestinationBankAccounts(actor, destination.id, t), 'FINANCE_INTERCOMPANY_DESTINATION_FORBIDDEN');
    await expectCode(() => intercompanyService.listDestinationBankAccounts(actor, tenant.companyId, t), 'FINANCE_INTERCOMPANY_DESTINATION_INVALID');
    // M45 F8: a tela recebe o indicador por empresa em vez de contas vazias.
    let dests = await intercompanyService.listDestinationCompanies(actor, t);
    assert.equal(dests.find((c) => c.id === destination.id).canReadFinance, false);
    assert.ok(!dests.some((c) => c.id === tenant.companyId), 'a empresa atual não é destino');
    const membership = await UserMembership.findOne({ where: { userId: tenant.userId, companyId: tenant.companyId, status: 'ACTIVE' }, transaction: t });
    await inCompany(t, destination.id, () =>
      UserMembership.create({ groupId: tenant.groupId, companyId: destination.id, userId: tenant.userId, roleId: membership.roleId, status: 'ACTIVE' }, { transaction: t })
    );
    dests = await intercompanyService.listDestinationCompanies(actor, t);
    assert.equal(dests.find((c) => c.id === destination.id).canReadFinance, true);
    const accounts = await intercompanyService.listDestinationBankAccounts(actor, destination.id, t);
    assert.deepEqual(accounts.map((a) => a.id), [base.toBankAccountId]);
    // Contexto restaurado: a conta do destino continua invisível na origem.
    assert.equal(await BankAccount.findByPk(base.toBankAccountId, { transaction: t }), null);
  });
});

// ==================================================================================
// §14 Comissões
// ==================================================================================

test('F3-CM1 percentual/base/versão nunca vêm do pedido; sem regra publicada falha fechado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const source = await newReceivable(t, 1000);
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, beneficiaryUserId: tenant.userId, sourceEntryId: source.id, component: 'BROKER', idempotencyKey: `f3-cm1-${uniqueSuffix()}` };
    await expectCode(() => commissionsService.createCommission({ ...base, percentage: 50 }, tenant.userId, t), 'FINANCE_COMMISSION_VALUES_FROM_RULE');
    await expectCode(() => commissionsService.createCommission({ ...base, baseAmount: 999999 }, tenant.userId, t), 'FINANCE_COMMISSION_VALUES_FROM_RULE');
    await expectCode(() => commissionsService.createCommission({ ...base, ruleVersionId: source.id }, tenant.userId, t), 'FINANCE_COMMISSION_VALUES_FROM_RULE');
    await expectCode(() => commissionsService.createCommission({ ...base, sourceEntryId: undefined }, tenant.userId, t), 'FINANCE_COMMISSION_VALIDATION');

    // Empresa nova do grupo, sem regra publicada: não existe percentual padrão inventado.
    const fresh = await Company.create({ groupId: tenant.groupId, name: `F3 Sem Regra ${uniqueSuffix()}`, status: 'ACTIVE' }, { transaction: t });
    await inCompany(t, fresh.id, () =>
      expectCode(() => commissionsService.getActiveCommissionRule(tenant.groupId, fresh.id, t), 'FINANCE_COMMISSION_RULE_NOT_CONFIGURED')
    );
  });
});

test('F3-CM2 comissão calculada pelo Motor de Regras grava rule_version_id; nova versão não altera a antiga; banco exige a versão', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const v1 = await commissionsService.publishCommissionRuleVersion({ groupId: tenant.groupId, companyId: tenant.companyId, componentPercentages: { BROKER: 6, MANAGER: 1.5 } }, tenant.userId, t);
    const source = await newReceivable(t, 2000);
    const { commission } = await commissionsService.createCommission(
      { groupId: tenant.groupId, companyId: tenant.companyId, beneficiaryUserId: tenant.userId, sourceEntryId: source.id, component: 'BROKER', idempotencyKey: `f3-cm2-${uniqueSuffix()}` },
      tenant.userId,
      t
    );
    assert.equal(commission.ruleVersionId, v1.id);
    assert.equal(Number(commission.percentage), 6);
    assert.equal(Number(commission.baseAmount), 2000);
    assert.equal(Number(commission.totalAmount), 120);

    const v2 = await commissionsService.publishCommissionRuleVersion({ groupId: tenant.groupId, companyId: tenant.companyId, componentPercentages: { BROKER: 8, MANAGER: 1.5 } }, tenant.userId, t);
    assert.notEqual(v2.id, v1.id);
    const reread = await Commission.findByPk(commission.id, { transaction: t });
    assert.equal(reread.ruleVersionId, v1.id, 'comissão já calculada continua apontando para a versão usada');
    assert.equal(Number(reread.totalAmount), 120);

    const { commission: manager } = await commissionsService.createCommission(
      { groupId: tenant.groupId, companyId: tenant.companyId, beneficiaryUserId: tenant.userId, sourceEntryId: source.id, component: 'MANAGER', idempotencyKey: `f3-cm2b-${uniqueSuffix()}` },
      tenant.userId,
      t
    );
    assert.equal(manager.ruleVersionId, v2.id);
    assert.equal(Number(manager.totalAmount), 30, 'componentes separados, cada um com seu percentual');
    await expectCode(
      () => commissionsService.createCommission(
        { groupId: tenant.groupId, companyId: tenant.companyId, beneficiaryUserId: tenant.userId, sourceEntryId: source.id, component: 'CORRESPONDENT', idempotencyKey: `f3-cm2c-${uniqueSuffix()}` },
        tenant.userId,
        t
      ),
      'FINANCE_COMMISSION_RULE_COMPONENT_NOT_CONFIGURED'
    );

    const noVersion = await sqlError(t, 'UPDATE finance.commissions SET rule_version_id = NULL WHERE id = :id', { id: commission.id });
    assert.ok(noVersion && /commissions_rule_fact_component_ck/.test(noVersion.message), String(noVersion && noVersion.message));
  });
});

test('F3-CM3 pagamento da comissão proporcional ao valor efetivamente recebido', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await commissionsService.publishCommissionRuleVersion({ groupId: tenant.groupId, companyId: tenant.companyId, componentPercentages: { BROKER: 10 } }, tenant.userId, t);
    const source = await newReceivable(t, 1000);
    const { commission, installments } = await commissionsService.createCommission(
      { groupId: tenant.groupId, companyId: tenant.companyId, beneficiaryUserId: tenant.userId, sourceEntryId: source.id, component: 'BROKER', installmentsCount: 2, idempotencyKey: `f3-cm3-${uniqueSuffix()}` },
      tenant.userId,
      t
    );
    assert.equal(Number(commission.totalAmount), 100);
    assert.equal(installments.length, 2);

    let release = await commissionsService.getCommissionRelease(commission.id, t);
    assert.equal(release.receivedAmount, 0);
    assert.equal(release.availableAmount, 0);
    const pay1 = await newSettledPayable(t, 50);
    await expectCode(() => commissionsService.markInstallmentPaid(installments[0].id, pay1.id, tenant.userId, t), 'FINANCE_COMMISSION_NOT_RELEASED');

    // Recebe 50% -> libera 50% da comissão (R$ 50 = uma parcela).
    await financialEntriesService.settleFinancialEntryPartial(source.id, 500, tenant.userId, t);
    release = await commissionsService.getCommissionRelease(commission.id, t);
    assert.equal(release.receivedAmount, 500);
    assert.equal(release.releasedAmount, 50);
    await commissionsService.markInstallmentPaid(installments[0].id, pay1.id, tenant.userId, t);
    const pay2 = await newSettledPayable(t, 50);
    await expectCode(() => commissionsService.markInstallmentPaid(installments[1].id, pay2.id, tenant.userId, t), 'FINANCE_COMMISSION_NOT_RELEASED');

    // Recebe o restante -> libera o resto.
    await financialEntriesService.settleFinancialEntryPartial(source.id, 500, tenant.userId, t);
    release = await commissionsService.getCommissionRelease(commission.id, t);
    assert.equal(release.receivedAmount, 1000);
    assert.equal(release.availableAmount, 50);
    const paid = await commissionsService.markInstallmentPaid(installments[1].id, pay2.id, tenant.userId, t);
    assert.equal(paid.status, 'PAID');
  });
});

// ==================================================================================
// §12 Repasse ao proprietário
// ==================================================================================

async function repasseSetup(t) {
  const suffix = uniqueSuffix();
  const owner = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Proprietário F3 ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  const property = await Property.create({ groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel F3 ${suffix}`, internalCode: `F3-${suffix}`, propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  const received = await newReceivable(t, 3000);
  await financialEntriesService.settleFinancialEntry(received.id, tenant.userId, t);
  const bankAccount = await newBankAccount(t);
  const costCenter = await createTestCostCenter(tenant, t);
  const base = { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, ownerPersonId: owner.id, bankAccountId: bankAccount.id, sourceEntryIds: [received.id], grossAmount: 1000, deductionsAmount: 100, deductionsReason: 'Taxa de administração', referenceMonth: '2026-09' };
  return { base, costCenter, received };
}

test('F3-RP1 período obrigatório e único por proprietário/imóvel/contrato (serviço e índice no banco)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { base } = await repasseSetup(t);
    await expectCode(() => ownerRepassesService.createOwnerRepasse({ ...base, referenceMonth: undefined }, tenant.userId, t), 'FINANCE_OWNER_REPASSE_PERIOD_REQUIRED');
    await expectCode(() => ownerRepassesService.createOwnerRepasse({ ...base, referenceMonth: '2026-13' }, tenant.userId, t), 'FINANCE_OWNER_REPASSE_PERIOD_REQUIRED');
    const first = await ownerRepassesService.createOwnerRepasse(base, tenant.userId, t);
    assert.equal(first.referenceMonth, '2026-09');
    await expectCode(() => ownerRepassesService.createOwnerRepasse({ ...base, grossAmount: 10, deductionsAmount: 0 }, tenant.userId, t), 'FINANCE_OWNER_REPASSE_PERIOD_DUPLICATE');
    // Mesmo pulando o serviço, o banco não aceita o segundo repasse vivo do período.
    const dup = await sqlError(
      t,
      `INSERT INTO finance.owner_repasses (id, group_id, company_id, property_id, owner_person_id, gross_amount, deductions_amount, net_amount, reference_month, status, created_at, updated_at)
       VALUES (gen_random_uuid(), :g, :c, :p, :o, 10, 0, 10, '2026-09', 'PENDING', now(), now())`,
      { g: tenant.groupId, c: tenant.companyId, p: base.propertyId, o: base.ownerPersonId }
    );
    assert.ok(dup && /owner_repasses_one_per_period_uq/.test(dup.message), String(dup && dup.message));
    // Outro período: permitido.
    const other = await ownerRepassesService.createOwnerRepasse({ ...base, grossAmount: 500, deductionsAmount: 0, referenceMonth: '2026-10' }, tenant.userId, t);
    assert.equal(other.status, 'PENDING');
  });
});

test('F3-RP2 aprovação por outra pessoa, confirmação só com pagamento liquidado e comprovante', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { base, costCenter } = await repasseSetup(t);
    const repasse = await ownerRepassesService.createOwnerRepasse(base, tenant.userId, t);

    await expectCode(() => ownerRepassesService.payOwnerRepasse(repasse.id, tenant.userId, t), 'FINANCE_OWNER_REPASSE_NOT_APPROVED');
    await expectCode(() => ownerRepassesService.approveOwnerRepasse(repasse.id, { costCenterId: costCenter.id }, tenant.userId, t), 'FINANCE_OWNER_REPASSE_SELF_APPROVAL_FORBIDDEN');

    const checker = await newUser(t, 'checker-rep');
    const { repasse: approved, financialEntry } = await ownerRepassesService.approveOwnerRepasse(repasse.id, { costCenterId: costCenter.id }, checker.id, t);
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.approvedByUserId, checker.id);
    assert.equal(financialEntry.nature, 'PAYABLE');
    assert.equal(Number(financialEntry.amount), 900);
    assert.equal(financialEntry.bankAccountId, base.bankAccountId);
    await expectCode(() => ownerRepassesService.approveOwnerRepasse(repasse.id, { costCenterId: costCenter.id }, checker.id, t), 'FINANCE_OWNER_REPASSE_INVALID_STATUS');

    // Aprovado mas não pago de fato: não confirma.
    await expectCode(() => ownerRepassesService.payOwnerRepasse(repasse.id, tenant.userId, t), 'FINANCE_OWNER_REPASSE_PAYMENT_NOT_CONFIRMED');

    const { file } = await settlePayableWithEvidence(t, financialEntry.id);
    const paid = await ownerRepassesService.payOwnerRepasse(repasse.id, tenant.userId, t);
    assert.equal(paid.status, 'PAID');
    assert.ok(paid.paidAt);
    assert.equal(paid.paymentEvidenceFileId, file.id);
    assert.equal(paid.paymentSettlementMethod, 'MANUAL_WITH_EVIDENCE');
    await expectCode(() => ownerRepassesService.payOwnerRepasse(repasse.id, tenant.userId, t), 'FINANCE_OWNER_REPASSE_ALREADY_PAID');

    // Banco: PAID sem comprovante/confirmação é recusado.
    const noEvidence = await sqlError(t, 'UPDATE finance.owner_repasses SET payment_evidence_file_id = NULL WHERE id = :id', { id: repasse.id });
    assert.ok(noEvidence && /owner_repasses_paid_confirmation_ck/.test(noEvidence.message), String(noEvidence && noEvidence.message));
    // Banco: aprovador = quem criou é recusado.
    const selfApproved = await sqlError(t, 'UPDATE finance.owner_repasses SET approved_by_user_id = created_by WHERE id = :id', { id: repasse.id });
    assert.ok(selfApproved && /owner_repasses_maker_checker_ck/.test(selfApproved.message), String(selfApproved && selfApproved.message));
  });
});

test('F3-RP3 trava contra repasse duplo: FOR UPDATE nos recebimentos de origem, no repasse e no lançamento', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { base, costCenter } = await repasseSetup(t);
    const captured = [];
    const previous = sequelize.options.logging;
    sequelize.options.logging = (sql) => captured.push(String(sql));
    let repasse;
    try {
      repasse = await ownerRepassesService.createOwnerRepasse(base, tenant.userId, t);
      const sourceLock = captured.find((s) => /FROM "finance"\."financial_entries"/.test(s) && /FOR UPDATE/.test(s));
      assert.ok(sourceLock, 'a criação trava os recebimentos de origem (FOR UPDATE) antes de ler o saldo já alocado');
      captured.length = 0;
      const checker = await newUser(t, 'checker-lock');
      await ownerRepassesService.approveOwnerRepasse(repasse.id, { costCenterId: costCenter.id }, checker.id, t);
      assert.ok(captured.some((s) => /FROM "finance"\."owner_repasses"/.test(s) && /FOR UPDATE/.test(s)), 'a aprovação trava o repasse (FOR UPDATE)');
      captured.length = 0;
      await expectCode(() => ownerRepassesService.payOwnerRepasse(repasse.id, tenant.userId, t), 'FINANCE_OWNER_REPASSE_PAYMENT_NOT_CONFIRMED');
      assert.ok(captured.some((s) => /FROM "finance"\."owner_repasses"/.test(s) && /FOR UPDATE/.test(s)), 'a confirmação trava o repasse (FOR UPDATE)');
    } finally {
      sequelize.options.logging = previous;
    }
    // Saldo do recebimento: um segundo repasse (outro período) não reutiliza o que já foi alocado.
    await expectCode(
      () => ownerRepassesService.createOwnerRepasse({ ...base, referenceMonth: '2026-11', grossAmount: 2500, deductionsAmount: 0 }, tenant.userId, t),
      'FINANCE_OWNER_REPASSE_EXCEEDS_ELIGIBLE_CAP'
    );
    const rest = await ownerRepassesService.createOwnerRepasse({ ...base, referenceMonth: '2026-11', grossAmount: 2000, deductionsAmount: 0 }, tenant.userId, t);
    assert.equal(Number(rest.grossAmount), 2000);
    // Uma única linha do lançamento a pagar por repasse (índice único em financial_entry_id).
    const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM finance.owner_repasses WHERE financial_entry_id = (SELECT financial_entry_id FROM finance.owner_repasses WHERE id = :id)', { replacements: { id: repasse.id }, transaction: t });
    assert.equal(n, 1);
    assert.ok(await OwnerRepass.findByPk(repasse.id, { transaction: t }));
  });
});

// ==================================================================================
// §4 Plano de contas versionado
// ==================================================================================

test('F3-PC1 cada alteração gera versão append-only; o lançamento usa a classificação vigente na data do fato', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const suffix = uniqueSuffix();
    const account = await chartService.createAccount({ groupId: tenant.groupId, companyId: tenant.companyId, code: `F3.${suffix}`, name: 'Receita de aluguel', accountType: 'REVENUE' }, tenant.userId, t);
    let versions = await chartService.listAccountVersions(account.id, t);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].name, 'Receita de aluguel');

    // Fato no passado (antes da reclassificação) e fato de hoje.
    const pastFact = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    await new Promise((r) => setTimeout(r, 5));
    await chartService.updateAccount(account.id, { name: 'Receita de locação residencial', changeReason: 'Reclassificação' }, tenant.userId, t);
    versions = await chartService.listAccountVersions(account.id, t);
    assert.equal(versions.length, 2);
    assert.ok(versions[0].effectiveUntil, 'a versão anterior teve a vigência encerrada');
    assert.equal(versions[1].effectiveUntil, null);
    assert.equal(versions[1].changeReason, 'Reclassificação');

    const today = await newReceivable(t, 10, { chartOfAccountId: account.id });
    assert.equal(today.chartOfAccountVersionId, versions[1].id, 'fato de hoje usa a versão vigente hoje');
    const past = await newReceivable(t, 10, { chartOfAccountId: account.id, factDate: pastFact });
    assert.equal(past.chartOfAccountVersionId, versions[0].id, 'fato anterior à reclassificação usa a versão daquela data');

    // Desativar = nova versão inativa; fato de hoje recusado, fato antigo ainda classificável.
    await chartService.deactivateAccount(account.id, tenant.userId, t);
    versions = await chartService.listAccountVersions(account.id, t);
    assert.equal(versions.length, 3);
    assert.equal(versions[2].isActive, false);
    await expectCode(() => newReceivable(t, 10, { chartOfAccountId: account.id }), 'FINANCE_CHART_ACCOUNT_INACTIVE');
    const late = await newReceivable(t, 10, { chartOfAccountId: account.id, factDate: pastFact });
    assert.equal(late.chartOfAccountVersionId, versions[0].id);

    // Lançamento antigo não muda de classificação quando a conta muda.
    const reread = await FinancialEntry.findByPk(today.id, { transaction: t });
    assert.equal(reread.chartOfAccountVersionId, versions[1].id);
  });
});

test('F3-PC2 versões do plano de contas são append-only no banco e o lançamento novo exige a versão', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const account = await chartService.createAccount({ groupId: tenant.groupId, companyId: tenant.companyId, code: `F3B.${uniqueSuffix()}`, name: 'Despesa X', accountType: 'EXPENSE' }, tenant.userId, t);
    const [v1] = await chartService.listAccountVersions(account.id, t);
    const rename = await sqlError(t, "UPDATE finance.chart_of_account_versions SET name = 'Outro' WHERE id = :id", { id: v1.id });
    assert.ok(rename && /append-only/.test(rename.message), String(rename && rename.message));
    const del = await sqlError(t, 'DELETE FROM finance.chart_of_account_versions WHERE id = :id', { id: v1.id });
    assert.ok(del && /append-only/.test(del.message));
    assert.ok(await ChartOfAccountVersion.findByPk(v1.id, { transaction: t }));

    const entry = await newReceivable(t, 10, { chartOfAccountId: account.id });
    const noVersion = await sqlError(t, 'UPDATE finance.financial_entries SET chart_of_account_version_id = NULL WHERE id = :id', { id: entry.id });
    assert.ok(noVersion && /financial_entries_chart_version_ck/.test(noVersion.message), String(noVersion && noVersion.message));
  });
});

// ==================================================================================
// Ledger append-only (migrations 366/382) + auditoria das colunas mutáveis (421)
// ==================================================================================

const IMMUTABLE_UPDATES = {
  group_id: 'gen_random_uuid()',
  company_id: 'gen_random_uuid()',
  entry_type: "CASE WHEN entry_type = 'CREDIT' THEN 'DEBIT' ELSE 'CREDIT' END",
  nature: "'PAYABLE'",
  amount: 'amount + 1',
  due_at: "COALESCE(due_at, now()) + interval '1 day'",
  idempotency_key: "'f3-outra-chave-' || gen_random_uuid()",
  reversal_of_entry_id: 'gen_random_uuid()',
  created_at: "created_at - interval '1 day'",
  created_by: 'gen_random_uuid()',
  third_party_origin_entry_id: 'gen_random_uuid()',
  third_party_holder_person_id: 'gen_random_uuid()',
};

for (const [column, expression] of Object.entries(IMMUTABLE_UPDATES)) {
  test(`F3-LG ledger: coluna imutável "${column}" não pode ser alterada por UPDATE direto`, async () => {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const entry = await newReceivable(t, 77);
      const err = await sqlError(t, `UPDATE finance.financial_entries SET "${column}" = ${expression} WHERE id = :id`, { id: entry.id });
      assert.ok(err, `UPDATE em ${column} deveria falhar`);
      assert.match(err.message, new RegExp(`append-only.*"${column}"`), err.message);
      const reread = await FinancialEntry.findByPk(entry.id, { transaction: t });
      assert.equal(Number(reread.amount), 77);
    });
  });
}

test('F3-LG ledger: DELETE direto é sempre recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await newReceivable(t, 5);
    const err = await sqlError(t, 'DELETE FROM finance.financial_entries WHERE id = :id', { id: entry.id });
    assert.ok(err && /DELETE direto não é permitido/.test(err.message), String(err && err.message));
  });
});

test('F3-LG ledger: exceção estreita de nature — só PENDING_CLASSIFICATION com status PENDING pode ser classificado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const mk = () => FinancialEntry.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'PENDING_CLASSIFICATION', amount: 12, status: 'PENDING', description: `F3 pendente ${uniqueSuffix()}` },
      { transaction: t }
    );
    // (a) PENDING_CLASSIFICATION + PENDING -> classificação permitida.
    const a = await mk();
    const okErr = await sqlError(t, "UPDATE finance.financial_entries SET nature = 'RECEIVABLE' WHERE id = :id", { id: a.id });
    assert.equal(okErr, null, okErr && okErr.message);
    // (b) já classificado -> não volta nem troca de natureza.
    const back = await sqlError(t, "UPDATE finance.financial_entries SET nature = 'PAYABLE' WHERE id = :id", { id: a.id });
    assert.ok(back && /"nature"/.test(back.message));
    // (c) PENDING_CLASSIFICATION mas já liquidado -> recusado.
    const c = await mk();
    assert.equal(await sqlError(t, "UPDATE finance.financial_entries SET status = 'SETTLED', settled_at = now() WHERE id = :id", { id: c.id }), null);
    const settledErr = await sqlError(t, "UPDATE finance.financial_entries SET nature = 'RECEIVABLE' WHERE id = :id", { id: c.id });
    assert.ok(settledErr && /"nature"/.test(settledErr.message), String(settledErr && settledErr.message));
    // (d) nature + status mudando juntos de PENDING para SETTLED: vale o OLD (PENDING) — permitido.
    const d = await mk();
    assert.equal(await sqlError(t, "UPDATE finance.financial_entries SET nature = 'RECEIVABLE', status = 'SETTLED', settled_at = now() WHERE id = :id", { id: d.id }), null);
  });
});

test('F3-LG ledger: colunas mutáveis mudam, e toda mudança fica auditada pelo banco (só o que mudou, com o usuário)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const entry = await newReceivable(t, 33);
    const account = await newBankAccount(t);
    const err = await sqlError(t, "UPDATE finance.financial_entries SET bank_account_id = :b, description = 'alterado por SQL direto' WHERE id = :id", { id: entry.id, b: account.id });
    assert.equal(err, null, err && err.message);
    const logs = await AuditLog.findAll({ where: { entityType: 'FinancialEntryRow', entityId: entry.id }, transaction: t });
    assert.equal(logs.length, 1);
    const [log] = logs;
    assert.equal(log.action, 'finance.financial_entry.row_change');
    assert.equal(log.userId, tenant.userId);
    assert.deepEqual(Object.keys(log.afterJson).sort(), ['bank_account_id', 'description']);
    assert.equal(log.beforeJson.bank_account_id, null);
    assert.equal(log.afterJson.bank_account_id, account.id);

    // Só colunas de controle (updated_at/lock_version) não geram ruído de auditoria.
    await sqlError(t, 'UPDATE finance.financial_entries SET updated_at = now() WHERE id = :id', { id: entry.id });
    assert.equal(await AuditLog.count({ where: { entityType: 'FinancialEntryRow', entityId: entry.id }, transaction: t }), 1);

    // A mudança pelo serviço (liquidação) também deixa o rastro do banco.
    await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, t);
    const after = await AuditLog.findAll({ where: { entityType: 'FinancialEntryRow', entityId: entry.id }, order: [['occurred_at', 'ASC']], transaction: t });
    assert.ok(after.length >= 2);
    assert.ok(after.some((l) => l.afterJson.status === 'SETTLED'));
  });
});

test('M45-O2 listCommissions(includeInstallments) traz as parcelas numa só consulta (sem N+1)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await commissionsService.publishCommissionRuleVersion({ groupId: tenant.groupId, companyId: tenant.companyId, componentPercentages: { BROKER: 5 } }, tenant.userId, t);
    const source = await newReceivable(t, 2000);
    const { commission } = await commissionsService.createCommission(
      { groupId: tenant.groupId, companyId: tenant.companyId, beneficiaryUserId: tenant.userId, sourceEntryId: source.id, component: 'BROKER', installmentsCount: 2, idempotencyKey: `m45-o2-${uniqueSuffix()}` },
      tenant.userId,
      t
    );
    const list = await commissionsService.listCommissions(t, { includeInstallments: true, beneficiaryUserId: tenant.userId });
    const found = list.find((c) => c.id === commission.id);
    assert.ok(found, 'comissão listada');
    const expected = await commissionsService.listCommissionInstallments(commission.id, t);
    assert.equal(found.installments.length, expected.length);
    assert.ok(found.installments.length >= 1);
    const plain = await commissionsService.listCommissions(t, { beneficiaryUserId: tenant.userId });
    assert.equal(plain.find((c) => c.id === commission.id).installments, undefined, 'sem include, formato antigo');
  });
});
