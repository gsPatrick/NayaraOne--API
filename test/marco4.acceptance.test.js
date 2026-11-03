'use strict';

// Testes de aceite do Marco 4 (Financeiro) — fechando itens PARCIAIS da matriz M4-01 a M4-28
// que já tinham implementação real, só faltava prova automatizada.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter, createTestResultCenter, settleFinancialEntryWithApproval } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const { assertBankAccountEligibleForPayment } = require('../src/features/finance/financeAntifraud.service');
const ownerRepassesService = require('../src/features/finance/ownerRepasses.service');
const propertiesService = require('../src/features/properties/properties.service');
const {  Person } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// --- M4-05: proibição de edição destrutiva de lançamento já liquidado ---
test('M4-05 updateFinancialEntry bloqueia edição de lançamento SETTLED — ledger imutável (FIN-003)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const costCenterM405 = await createTestCostCenter(tenant, transaction);
    const entry = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 150, costCenterId: costCenterM405.id },
      tenant.userId,
      transaction
    );
    // Revisão 18/10/2026 (A1): PAYABLE, mesmo sem conta bancária, só liquida com aprovação e comprovante.
    await settleFinancialEntryWithApproval(tenant, entry.id, tenant.userId, transaction);

    await assert.rejects(
      () => financialEntriesService.updateFinancialEntry(entry.id, { description: 'tentando editar valor liquidado' }, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_ENTRY_IMMUTABLE'); return true; },
      'lançamento SETTLED não pode ser editado — precisa de estorno'
    );
  });
});

// --- M4-11: cooldown de 48h para conta bancária nova ---
test('M4-11 conta bancária nova fica em cooldown, bloqueia pagamento, e libera após o prazo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', accountNumber: `M411-${suffix}` },
      tenant.userId,
      transaction
    );
    assert.equal(account.status, 'PENDING_COOLDOWN');

    await assert.rejects(
      () => assertBankAccountEligibleForPayment(account.id, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_BANK_ACCOUNT_COOLDOWN'); return true; },
      'conta nova dentro do cooldown não pode receber pagamento'
    );

    // Simula o prazo de 48h já ter passado (sem esperar de verdade).
    await sequelize.query('UPDATE finance.bank_accounts SET updated_at = :ts WHERE id = :id', {
      replacements: { ts: new Date(Date.now() - 49 * 60 * 60 * 1000), id: account.id },
      transaction,
    });
    const result = await assertBankAccountEligibleForPayment(account.id, transaction);
    assert.ok(result === null || result.status === 'ACTIVE', 'após o cooldown, a conta deve ficar elegível (promoção automática pra ACTIVE)');
  });
});

// --- M4-15: repasses de proprietário segregados da receita própria ---
test('M4-15/contrato §12 createOwnerRepasse calcula líquido = min(bruto, teto elegível) - deduções, nunca editável diretamente', async () => {
  // FIX (auditoria externa 2026-10-07 — contrato bruto, Centro Financeiro §12 "Repasses de
  // proprietários"): "Repasse não pode ser maior que valor elegível recebido, salvo ajuste
  // formal." createOwnerRepasse agora EXIGE `sourceEntryIds` (lançamentos de recebimento reais,
  // SETTLED, RECEIVABLE) e recalcula o teto a partir deles — grossAmount livre não é mais
  // aceito sem vínculo com recebimento real.
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const owner = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M4-15 Proprietário ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, ownerPersonId: owner.id, bankCode: '001', accountNumber: `M415-${suffix}` },
      tenant.userId,
      transaction
    );
    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `M4-15 Imóvel ${suffix}`, internalCode: `M415P-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      transaction
    );

    // Recebimento real do locatário (aluguel), já liquidado — é isso que forma o teto elegível.
    const resultCenterM415 = await createTestResultCenter(tenant, transaction);
    const recebimento = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 1000, description: `M4-15 aluguel recebido ${suffix}`, resultCenterId: resultCenterM415.id },
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(recebimento.id, tenant.userId, transaction);

    const repasse = await ownerRepassesService.createOwnerRepasse(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        ownerPersonId: owner.id,
        bankAccountId: account.id,
        sourceEntryIds: [recebimento.id],
        grossAmount: 1000,
        deductionsAmount: 80,
        deductionsReason: 'Taxa de administração contratual',
        referenceMonth: '2026-09',
      },
      tenant.userId,
      transaction
    );
    assert.equal(Number(repasse.netAmount), 920, 'líquido precisa ser sempre bruto - deduções, calculado no servidor');
    assert.equal(repasse.status, 'PENDING');

    const composicao = await ownerRepassesService.getOwnerRepasseComposition(repasse.id, transaction);
    assert.equal(composicao.eligibleAmount, 1000);
    assert.equal(composicao.composition.length, 1);
    assert.equal(composicao.composition[0].financialEntryId, recebimento.id);

    // Tentar repasse SEM lançamento de recebimento real é bloqueado.
    await assert.rejects(
      () =>
        ownerRepassesService.createOwnerRepasse(
          { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, ownerPersonId: owner.id, bankAccountId: account.id, grossAmount: 500, referenceMonth: '2026-10' },
          tenant.userId,
          transaction
        ),
      (err) => { assert.equal(err.code, 'FINANCE_OWNER_REPASSE_VALIDATION'); return true; },
      'sourceEntryIds é obrigatório — não existe mais repasse "livre"'
    );

    // Tentar repasse acima do teto elegível (sem formalAdjustment) é bloqueado.
    const outroRecebimento = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 200, description: `M4-15 aluguel 2 ${suffix}`, resultCenterId: resultCenterM415.id },
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(outroRecebimento.id, tenant.userId, transaction);
    await assert.rejects(
      () =>
        ownerRepassesService.createOwnerRepasse(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            propertyId: property.id,
            ownerPersonId: owner.id,
            bankAccountId: account.id,
            sourceEntryIds: [outroRecebimento.id],
            grossAmount: 1000, // teto elegível real é só 200
            referenceMonth: '2026-11',
          },
          tenant.userId,
          transaction
        ),
      (err) => { assert.equal(err.code, 'FINANCE_OWNER_REPASSE_EXCEEDS_ELIGIBLE_CAP'); return true; },
      'repasse não pode exceder o valor elegível recebido, salvo ajuste formal'
    );

    // Sem exigir cooldown vencido, o pagamento deve ser bloqueado (mesma trava do M4-11). Frente 3
    // (§12): a trava agora vale na APROVAÇÃO (é ela que cria o lançamento a pagar na conta).
    const { User } = require('../src/models');
    const checker = await User.create({ email: `m415-checker-${suffix}@nayaraone.dev`, name: 'M4-15 aprovador', passwordHash: 'x', status: 'ACTIVE' }, { transaction });
    const costCenterM415 = await createTestCostCenter(tenant, transaction);
    await assert.rejects(
      () => ownerRepassesService.approveOwnerRepasse(repasse.id, { costCenterId: costCenterM415.id }, checker.id, transaction),
      (err) => { assert.equal(err.code, 'FINANCE_BANK_ACCOUNT_COOLDOWN'); return true; },
      'repasse pra conta em cooldown não pode ser pago — prova que a segregação/antifraude vale também pra repasse'
    );
  });
});

// FIN-TS-015 (auditoria externa Abacus AI, 11/10/2026): "Módulo existe mas sem repasses no
// ambiente; isolamento não comprovado." M4-15 acima já prova o CÁLCULO correto (teto elegível,
// dedução, nunca editável), mas não prova explicitamente a SEGREGAÇÃO do caixa próprio. Este
// teste fecha esse ângulo: pagar um repasse NUNCA cria nem toca um FinancialEntry da empresa
// (não é dinheiro próprio, não entra na receita/despesa da empresa — é só a baixa de status
// do repasse em si), diferente de qualquer outra liquidação do Financeiro.
//
// ATUALIZADO (Frente 3, §12 — aprovação, comprovante e trava): o pagamento do repasse deixou de
// ser uma troca de status sem rastro bancário. A aprovação (de outra pessoa) cria UM lançamento a
// pagar vinculado ao repasse (financial_entry_id, único) — é por ele que passam intenção bancária,
// comprovante e conciliação. A confirmação do repasse não cria mais nenhum lançamento.
test('FIN-TS-015: repasse gera exatamente UM lançamento a pagar (na aprovação) e a confirmação não cria nenhum outro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const owner = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `FIN-TS-015 Proprietário ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, ownerPersonId: owner.id, bankCode: '001', accountNumber: `FINTS015-${suffix}` },
      tenant.userId,
      transaction
    );
    await account.update({ status: 'ACTIVE' }, { transaction }); // pula o cooldown pra testar só o ponto deste teste

    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `FIN-TS-015 Imóvel ${suffix}`, internalCode: `FINTS015P-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      transaction
    );
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const recebimento = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 1000, description: `FIN-TS-015 aluguel ${suffix}`, resultCenterId: resultCenter.id },
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(recebimento.id, tenant.userId, transaction);

    const { FinancialEntry } = require('../src/models');
    const countAntes = await FinancialEntry.count({ where: { companyId: tenant.companyId }, transaction });

    const repasse = await ownerRepassesService.createOwnerRepasse(
      {
        groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, ownerPersonId: owner.id, bankAccountId: account.id,
        sourceEntryIds: [recebimento.id], grossAmount: 1000, deductionsAmount: 0, referenceMonth: '2026-09',
      },
      tenant.userId,
      transaction
    );
    const { User } = require('../src/models');
    const checker = await User.create({ email: `fints015-checker-${suffix}@nayaraone.dev`, name: 'FIN-TS-015 aprovador', passwordHash: 'x', status: 'ACTIVE' }, { transaction });
    const costCenter = await createTestCostCenter(tenant, transaction);
    const { financialEntry } = await ownerRepassesService.approveOwnerRepasse(repasse.id, { costCenterId: costCenter.id }, checker.id, transaction);
    assert.equal(financialEntry.nature, 'PAYABLE');
    assert.equal(Number(financialEntry.amount), 1000);
    // Segregação (19/10/2026): o dinheiro do repasse é do proprietário — lançamento marcado como
    // recurso de terceiro, fora da despesa própria (filtro isThirdPartyFunds=false).
    assert.equal(financialEntry.isThirdPartyFunds, true, 'pagamento de repasse é dinheiro de terceiro');
    assert.equal(financialEntry.thirdPartyReleaseType, 'OWNER_REPASSE');
    // A referência é texto para pessoas (bf653aa): período no formato MM/AAAA, sem ENUM nem ISO.
    assert.ok(financialEntry.thirdPartyReference && financialEntry.thirdPartyReference.includes('09/2026'), financialEntry.thirdPartyReference);
    const proprios = await FinancialEntry.findAll({ where: { companyId: tenant.companyId, isThirdPartyFunds: false }, transaction });
    assert.ok(!proprios.some((e) => e.id === financialEntry.id), 'repasse não aparece como despesa própria');
    const countAposAprovar = await FinancialEntry.count({ where: { companyId: tenant.companyId }, transaction });
    assert.equal(countAposAprovar, countAntes + 1, 'a aprovação cria exatamente um lançamento a pagar');

    // Baixa formal do lançamento a pagar: comprovante anexado -> aprovação de outra pessoa -> baixa.
    const { createManualSettlementEvidence } = require('./testHelpers');
    const approvalsService = require('../src/features/finance/approvals.service');
    const manualSettlement = await createManualSettlementEvidence(tenant, tenant.userId, transaction);
    await financialEntriesService.attachSettlementEvidence(financialEntry.id, manualSettlement, tenant.userId, transaction);
    const approval = await approvalsService.createApprovalRequest(
      { groupId: tenant.groupId, companyId: tenant.companyId, relatedEntityType: 'FinancialEntry', relatedEntityId: financialEntry.id, riskLevel: 'LOW' },
      tenant.userId,
      transaction
    );
    await approvalsService.decideApprovalStep(approval.id, { decision: 'APPROVED' }, checker.id, transaction);
    await financialEntriesService.settleFinancialEntry(financialEntry.id, tenant.userId, transaction, { manualSettlement });
    const countAntesConfirmar = await FinancialEntry.count({ where: { companyId: tenant.companyId }, transaction });
    const paid = await ownerRepassesService.payOwnerRepasse(repasse.id, tenant.userId, transaction);
    assert.equal(paid.status, 'PAID');
    assert.ok(paid.paymentEvidenceFileId, 'confirmação grava o comprovante do pagamento');

    const countDepois = await FinancialEntry.count({ where: { companyId: tenant.companyId }, transaction });
    assert.equal(countDepois, countAntesConfirmar, 'confirmar o repasse não cria nenhum lançamento novo');
  });
});
