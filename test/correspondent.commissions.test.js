'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const commissionsService = require('../src/features/correspondent/cases/commissionEntitlements.service');
const { publishCommissionSplitVersion } = require('../src/features/correspondent/commissionSplit.service');
const nfseService = require('../src/features/correspondent/fiscal/nfse.service');
const reconciliationService = require('../src/features/correspondent/fiscal/reconciliation.service');
const { Person, FinancialEntry } = require('../src/models');

let tenant;
let otherCompanyId;

before(async () => {
  tenant = await getSeedTenant();
  const [[row]] = await sequelize.query('SELECT id FROM core.companies WHERE id != :companyId LIMIT 1', {
    replacements: { companyId: tenant.companyId },
  });
  otherCompanyId = row ? row.id : '00000000-0000-0000-0000-000000000000';
});

after(async () => {
  await sequelize.close();
});

async function createCase(transaction, providerCode = 'sandbox') {
  const principal = await Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `Proponente Com ${uniqueSuffix()}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
  return financingCasesService.createFinancingCase(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      providerCode,
      applicants: [{ personId: principal.id, role: 'PRINCIPAL' }],
    },
    tenant.userId,
    transaction
  );
}

test('CORRESPONDENT-COM-01: cria direito a comissão EXPECTED com percentual do Motor de Regras', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'sandbox');
    const entitlement = await commissionsService.createCommissionEntitlement(
      financingCase.id,
      { baseAmount: 200000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    assert.equal(entitlement.status, 'EXPECTED');
    assert.equal(Number(entitlement.baseAmount), 200000);
    assert.equal(Number(entitlement.percentage), 1.5); // DEFAULT_ACTION.percentageByProvider.sandbox
    assert.equal(Number(entitlement.amount), 3000); // 200000 * 1.5%
    assert.ok(entitlement.ruleVersionId);
  });
});

test('CORRESPONDENT-COM-02: provider "manual" usa defaultPercentage quando não tem percentual específico', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction, 'manual');
    const entitlement = await commissionsService.createCommissionEntitlement(
      financingCase.id,
      { baseAmount: 100000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    assert.equal(Number(entitlement.percentage), 1); // percentageByProvider.manual
    assert.equal(Number(entitlement.amount), 1000);
  });
});

test('CORRESPONDENT-COM-03: baseAmount inválido é rejeitado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await assert.rejects(
      () =>
        commissionsService.createCommissionEntitlement(
          financingCase.id,
          { baseAmount: 0 },
          tenant.userId,
          tenant.groupId,
          tenant.companyId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'COMMISSION_ENTITLEMENT_VALIDATION');
        return true;
      }
    );
  });
});

test('CORRESPONDENT-COM-04: confirmar cria RECEIVABLE real no Financeiro e transiciona pra RECEIVABLE', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const entitlement = await commissionsService.createCommissionEntitlement(
      financingCase.id,
      { baseAmount: 150000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    const confirmationId = `ext-conf-${uniqueSuffix()}`;
    const confirmed = await commissionsService.confirmCommissionEntitlement(
      entitlement.id,
      { externalConfirmationId: confirmationId },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    assert.equal(confirmed.status, 'RECEIVABLE');
    assert.equal(confirmed.externalConfirmationId, confirmationId);
    assert.ok(confirmed.financialEntryId);

    const entry = await FinancialEntry.findByPk(confirmed.financialEntryId, { transaction });
    assert.ok(entry, 'o lançamento financeiro precisa existir de verdade');
    assert.equal(entry.nature, 'RECEIVABLE');
    assert.equal(entry.entryType, 'CREDIT');
    assert.equal(Number(entry.amount), Number(entitlement.amount));
  });
});

test('CORRESPONDENT-COM-05: confirmação idempotente — 2 chamadas com a mesma externalConfirmationId não duplicam o RECEIVABLE', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const entitlement = await commissionsService.createCommissionEntitlement(
      financingCase.id,
      { baseAmount: 80000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    const confirmationId = `ext-conf-dup-${uniqueSuffix()}`;

    const first = await commissionsService.confirmCommissionEntitlement(
      entitlement.id,
      { externalConfirmationId: confirmationId },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    const second = await commissionsService.confirmCommissionEntitlement(
      entitlement.id,
      { externalConfirmationId: confirmationId },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );

    assert.equal(first.financialEntryId, second.financialEntryId, 'a 2ª confirmação precisa retornar o MESMO lançamento, não criar um novo');

    const entries = await FinancialEntry.findAll({
      where: { idempotencyKey: `correspondent.commission.confirmed:${entitlement.id}` },
      transaction,
    });
    assert.equal(entries.length, 1, 'só pode existir UM lançamento financeiro para este entitlement');
  });
});

test('CORRESPONDENT-COM-06: confirmar com externalConfirmationId diferente de um já confirmado é rejeitado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const entitlement = await commissionsService.createCommissionEntitlement(
      financingCase.id,
      { baseAmount: 50000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    await commissionsService.confirmCommissionEntitlement(
      entitlement.id,
      { externalConfirmationId: `conf-a-${uniqueSuffix()}` },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    await assert.rejects(
      () =>
        commissionsService.confirmCommissionEntitlement(
          entitlement.id,
          { externalConfirmationId: `conf-b-${uniqueSuffix()}` },
          tenant.userId,
          tenant.groupId,
          tenant.companyId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'COMMISSION_ENTITLEMENT_ALREADY_CONFIRMED');
        return true;
      }
    );
  });
});

test('CORRESPONDENT-COM-07: chargeback cria ajuste e preserva o registro original (nunca apaga/edita o valor)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const entitlement = await commissionsService.createCommissionEntitlement(
      financingCase.id,
      { baseAmount: 60000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    const confirmed = await commissionsService.confirmCommissionEntitlement(
      entitlement.id,
      { externalConfirmationId: `conf-cb-${uniqueSuffix()}` },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    const originalAmount = Number(entitlement.amount);
    assert.ok(confirmed.financialEntryId, 'confirmação deveria criar um FinancialEntry real');
    const entryBefore = await FinancialEntry.findByPk(confirmed.financialEntryId, { transaction });
    assert.equal(entryBefore.status, 'PENDING');

    const { entitlement: afterChargeback, adjustment } = await commissionsService.chargebackCommissionEntitlement(
      entitlement.id,
      'Caso cancelado pelo cliente após confirmação.',
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );

    assert.equal(afterChargeback.status, 'ADJUSTED');
    assert.equal(Number(afterChargeback.amount), originalAmount, 'o valor original nunca pode mudar — ajuste é um registro novo, não uma edição');
    assert.equal(adjustment.adjustmentType, 'CHARGEBACK');
    assert.equal(Number(adjustment.adjustmentAmount), -originalAmount);

    const adjustments = await commissionsService.getCommissionEntitlementAdjustments(entitlement.id, transaction);
    assert.equal(adjustments.length, 1);

    // Achado real (auditoria pós-DoD): o chargeback precisa estornar de verdade o lançamento
    // financeiro real criado na confirmação — nunca deixar um recebível "fantasma" aberto no
    // Financeiro depois que a comissão que o originou foi estornada aqui.
    const entryAfter = await FinancialEntry.findByPk(confirmed.financialEntryId, { transaction });
    assert.equal(entryAfter.status, 'REVERSED', 'o FinancialEntry original precisa ser estornado quando a comissão é charged back');
    const reversal = await FinancialEntry.findOne({ where: { reversalOfEntryId: confirmed.financialEntryId }, transaction });
    assert.ok(reversal, 'deveria existir um lançamento compensatório de estorno');
  });
});

test('CORRESPONDENT-COM-08: chargeback sem motivo é rejeitado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const entitlement = await commissionsService.createCommissionEntitlement(
      financingCase.id,
      { baseAmount: 60000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    await assert.rejects(
      () => commissionsService.chargebackCommissionEntitlement(entitlement.id, '', tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => {
        assert.equal(err.code, 'COMMISSION_ENTITLEMENT_CHARGEBACK_REASON_REQUIRED');
        return true;
      }
    );
  });
});

test('CORRESPONDENT-COM-09: RLS — entitlement de outra empresa não é encontrado (cross-company bloqueado)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await assert.rejects(
      () =>
        commissionsService.createCommissionEntitlement(
          financingCase.id,
          { baseAmount: 10000 },
          tenant.userId,
          tenant.groupId,
          otherCompanyId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'FINANCING_CASE_NOT_FOUND');
        return true;
      }
    );
  });
});

test('CORRESPONDENT-COM-10: eventos commission.entitlement.created e commission.confirmed emitidos no outbox', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const entitlement = await commissionsService.createCommissionEntitlement(
      financingCase.id,
      { baseAmount: 40000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    await commissionsService.confirmCommissionEntitlement(
      entitlement.id,
      { externalConfirmationId: `conf-ev-${uniqueSuffix()}` },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    const [rows] = await sequelize.query(
      `SELECT event_type FROM integration.outbox_events WHERE aggregate_id = :id ORDER BY event_type`,
      { replacements: { id: entitlement.id }, transaction }
    );
    const types = rows.map((r) => r.event_type);
    assert.ok(types.includes('commission.entitlement.created'));
    assert.ok(types.includes('commission.confirmed'));
  });
});

test('CORRESPONDENT-COM-11: lista entitlements do case, mais recente primeiro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const first = await commissionsService.createCommissionEntitlement(financingCase.id, { baseAmount: 10000 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const second = await commissionsService.createCommissionEntitlement(financingCase.id, { baseAmount: 20000 }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const list = await commissionsService.listCommissionEntitlements(financingCase.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, second.id);
    assert.equal(list[1].id, first.id);
  });
});

test('CORRESPONDENT-COM-12: percentual de comissão acima de 100% (erro de configuração) é rejeitado, nunca gera comissão maior que a base', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    await publishCommissionSplitVersion(
      tenant.groupId,
      tenant.companyId,
      { percentageByProvider: { sandbox: 150 }, defaultPercentage: 1 },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => commissionsService.createCommissionEntitlement(financingCase.id, { baseAmount: 10000 }, tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => {
        assert.equal(err.code, 'COR_COMMISSION_SPLIT_PERCENTAGE_TOO_HIGH');
        return true;
      }
    );
  });
});

test('CORRESPONDENT-COM-13: chargeback de comissão com NFS-e já emitida abre reconciliação fiscal (nunca cancela a nota sozinho)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const entitlement = await commissionsService.createCommissionEntitlement(
      financingCase.id,
      { baseAmount: 60000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    await commissionsService.confirmCommissionEntitlement(
      entitlement.id,
      { externalConfirmationId: `conf-nfse-${uniqueSuffix()}` },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    const invoice = await nfseService.requestInvoice(
      { sourceType: 'COMMISSION_ENTITLEMENT', sourceId: entitlement.id, amount: Number(entitlement.amount), description: 'NFS-e da comissão de teste' },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    assert.notEqual(invoice.status, 'CANCELED');

    await commissionsService.chargebackCommissionEntitlement(
      entitlement.id,
      'Cliente desistiu do financiamento após a comissão já ter sido confirmada e faturada.',
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );

    // A NFS-e NUNCA é cancelada automaticamente (decisão fiscal exige revisão humana).
    const invoiceAfter = await nfseService.listInvoiceRequests(tenant.groupId, tenant.companyId, transaction);
    const sameInvoice = invoiceAfter.find((i) => i.id === invoice.id);
    assert.notEqual(sameInvoice.status, 'CANCELED', 'o chargeback não deve cancelar a NFS-e sozinho');

    // Mas uma reconciliação fiscal precisa ter sido aberta — "diferença nunca ignorada silenciosamente".
    const reconciliations = await reconciliationService.listReconciliations('OPEN', tenant.groupId, tenant.companyId, transaction);
    const opened = reconciliations.find((r) => r.referenceId === entitlement.id && r.reconciliationType === 'COMMISSION_X_FISCAL');
    assert.ok(opened, 'deveria ter aberto uma fiscal_reconciliation COMMISSION_X_FISCAL pra essa comissão');
    assert.equal(Number(opened.expectedAmount), 0);
    assert.equal(Number(opened.actualAmount), Number(invoice.amount));
  });
});

test('CORRESPONDENT-COM-14: chargeback de comissão SEM NFS-e não abre reconciliação nenhuma', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const financingCase = await createCase(transaction);
    const entitlement = await commissionsService.createCommissionEntitlement(
      financingCase.id,
      { baseAmount: 60000 },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    await commissionsService.chargebackCommissionEntitlement(
      entitlement.id,
      'Caso cancelado antes de qualquer confirmação ou nota fiscal.',
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    const reconciliations = await reconciliationService.listReconciliations('OPEN', tenant.groupId, tenant.companyId, transaction);
    const opened = reconciliations.find((r) => r.referenceId === entitlement.id);
    assert.equal(opened, undefined, 'sem NFS-e emitida, não deve abrir reconciliação nenhuma');
  });
});
