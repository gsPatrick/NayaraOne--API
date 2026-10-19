'use strict';

// GAP REAL CORRIGIDO (varredura completa Marco 4 contra o Caderno Técnico, 11/10/2026):
// "finance.budgets_forecasts" (Caderno §5) nunca existia. Cobre criação com validação de
// centro obrigatório por natureza, listagem por mês, e comparação orçado x realizado.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter, createTestResultCenter, settleFinancialEntryWithApproval } = require('./testHelpers');
const budgetsForecastsService = require('../src/features/finance/budgetsForecasts.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});

test('createBudgetForecast exige costCenterId para PAYABLE e resultCenterId para RECEIVABLE', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () =>
        budgetsForecastsService.createBudgetForecast(
          { groupId: tenant.groupId, companyId: tenant.companyId, competenceMonth: '2026-11', nature: 'PAYABLE', forecastedAmount: 100 },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'FINANCE_BUDGET_FORECAST_COST_CENTER_REQUIRED');
        return true;
      }
    );
    await assert.rejects(
      () =>
        budgetsForecastsService.createBudgetForecast(
          { groupId: tenant.groupId, companyId: tenant.companyId, competenceMonth: '2026-11', nature: 'RECEIVABLE', forecastedAmount: 100 },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'FINANCE_BUDGET_FORECAST_RESULT_CENTER_REQUIRED');
        return true;
      }
    );
  });
});

test('createBudgetForecast + listBudgetForecasts + compareForecastToRealized: orçado x realizado no mesmo mês de competência', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const month = '2026-12';
    const costCenter = await createTestCostCenter(tenant, transaction);
    const resultCenter = await createTestResultCenter(tenant, transaction);

    await budgetsForecastsService.createBudgetForecast(
      { groupId: tenant.groupId, companyId: tenant.companyId, competenceMonth: month, nature: 'PAYABLE', costCenterId: costCenter.id, forecastedAmount: 1000, description: `orçado despesa ${suffix}` },
      tenant.userId,
      transaction
    );
    await budgetsForecastsService.createBudgetForecast(
      { groupId: tenant.groupId, companyId: tenant.companyId, competenceMonth: month, nature: 'RECEIVABLE', resultCenterId: resultCenter.id, forecastedAmount: 2000, description: `orçado receita ${suffix}` },
      tenant.userId,
      transaction
    );

    const listed = await budgetsForecastsService.listBudgetForecasts(transaction, { competenceMonth: month });
    assert.equal(listed.length, 2);

    // Realizado: só 700 de despesa efetivamente liquidada nesse mês (abaixo do orçado de 1000).
    const custo = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 700, costCenterId: costCenter.id, competenceMonth: month, description: `realizado despesa ${suffix}` },
      tenant.userId,
      transaction
    );
    await settleFinancialEntryWithApproval(tenant, custo.id, tenant.userId, transaction); // A1 (revisão 18/10): PAYABLE exige aprovação + comprovante

    const comparison = await budgetsForecastsService.compareForecastToRealized(month, transaction);
    const payable = comparison.find((c) => c.nature === 'PAYABLE');
    const receivable = comparison.find((c) => c.nature === 'RECEIVABLE');

    assert.equal(payable.forecasted, 1000);
    assert.equal(payable.realized, 700);
    assert.equal(payable.variance, -300, 'gastou 300 a menos que o orçado');

    assert.equal(receivable.forecasted, 2000);
    assert.equal(receivable.realized, 0, 'nenhuma receita foi liquidada nesse mês');
    assert.equal(receivable.variance, -2000);
  });
});
