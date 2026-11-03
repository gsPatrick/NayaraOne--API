'use strict';

// R7 (reconferência ao vivo 20/10/2026) — antifraude: "Aberto em data não registrada", sem quem
// resolveu, sem o lançamento e título genérico. A API agora devolve createdAt correto (o model
// usa created_at underscored), quem resolveu, o lançamento relacionado e o título em português.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter } = require('./testHelpers');
const anomalyCasesService = require('../src/features/finance/anomalyCases.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

async function entry(transaction) {
  const cc = await createTestCostCenter(tenant, transaction);
  return financialEntriesService.createFinancialEntry(
    { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 88, description: `R7 lanc ${uniqueSuffix()}`, costCenterId: cc.id },
    tenant.userId, transaction
  );
}

test('R7: lista devolve data de abertura, título em português e lançamento relacionado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await entry(t);
    const created = await anomalyCasesService.createAnomalyCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'BENEFICIARY_CHANGED', riskLevel: 'HIGH', relatedEntityType: 'FinancialEntry', relatedEntityId: e.id, reason: 'Conta do favorecido trocada após a aprovação.' },
      tenant.userId, t
    );
    const list = await anomalyCasesService.listAnomalyCases(t, { status: 'OPEN' });
    const item = list.find((c) => c.id === created.id);
    assert.ok(item, 'caso listado');
    assert.match(item.createdAt, /^\d{4}-\d{2}-\d{2}T/, 'createdAt preenchido (ISO)');
    assert.equal(item.caseTypeLabel, 'Conta bancária do favorecido trocada');
    assert.equal(item.relatedEntry.id, e.id);
    assert.equal(item.relatedEntry.description, e.description);
    assert.equal(item.resolvedAt, null);
    assert.equal(item.resolvedByName, null);
  });
});

test('R7: caso resolvido mostra data e nome de quem resolveu; todos os tipos do sistema têm título', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await entry(t);
    const created = await anomalyCasesService.createAnomalyCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'AMOUNT_OUTLIER', riskLevel: 'MEDIUM', relatedEntityType: 'FinancialEntry', relatedEntityId: e.id, reason: 'Valor fora do padrão.' },
      tenant.userId, t
    );
    const resolved = await anomalyCasesService.resolveAnomalyCase(created.id, tenant.userId, t, 'Conferido com o fornecedor.');
    assert.equal(resolved.status, 'RESOLVED');
    assert.match(resolved.resolvedAt, /^\d{4}-/);
    assert.ok(resolved.resolvedByName && resolved.resolvedByName.length > 0, 'nome de quem resolveu');
    assert.equal(resolved.resolutionNote, 'Conferido com o fornecedor.');
    const list = await anomalyCasesService.listAnomalyCases(t, { status: 'RESOLVED' });
    assert.equal(list.find((c) => c.id === created.id).resolvedByName, resolved.resolvedByName);
  });
  for (const type of ['AMOUNT_OUTLIER', 'FREQUENT_REVERSAL', 'BENEFICIARY_CHANGED', 'BANK_CONFIRMATION_UNDER_REVIEW', 'POST_CLOSING_BANK_CONFIRMATION', 'DUPLICATE_SETTLEMENT']) {
    assert.notEqual(anomalyCasesService.caseTypeTitle(type), 'Outro tipo de alerta');
    assert.ok(anomalyCasesService.CASE_TYPE_TITLES[type], `${type} tem título`);
  }
});
