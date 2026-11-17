'use strict';

/**
 * Caderno M4 §4 (MARCO_4_CADERNO_COMPLETO.md:89): "Relatórios históricos usam a classificação vigente no fato". O fato do lançamento
 * é uma DATA (vencimento ao meio-dia de São Paulo), então a versão da conta é a que está em vigor no fim do DIA de negócio do fato.
 * Forma antiga (reprovada aqui): comparação pelo instante exato — um lançamento do dia, numa conta reclassificada ou desativada mais
 * tarde no mesmo dia, caía na primeira versão (ativa). O fato às 00:00 de hoje (São Paulo) torna o caso determinístico a qualquer hora.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestResultCenter } = require('./testHelpers');
const chartService = require('../src/modules/finance/application/services/chart-of-accounts.service');
const { resolveAccountVersionForEntry } = require('../src/modules/finance/application/services/chart-of-account-versions.service');
const financialEntriesService = require('../src/modules/finance/application/services/financial-entry.service');
const { startOfBusinessDay } = require('../src/utils/businessDate');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const inicioDeHoje = () => startOfBusinessDay(new Date()); // 00:00 de hoje em São Paulo: antes de qualquer versão criada agora
const ontem = () => new Date(startOfBusinessDay(new Date()).getTime() - 12 * 3600 * 1000);

async function receivable(t, accountId, dueAt) {
  const rc = await createTestResultCenter(tenant, t);
  return financialEntriesService.createFinancialEntry(
    { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 10, resultCenterId: rc.id, chartOfAccountId: accountId, dueAt, description: `Dia do fato ${uniqueSuffix()}` },
    tenant.userId,
    t
  );
}

test('M4 §4: lançamento do dia usa a classificação feita mais tarde no mesmo dia; fato de ontem fica com a primeira versão', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const account = await chartService.createAccount({ groupId: tenant.groupId, companyId: tenant.companyId, code: `DF.${uniqueSuffix()}`, name: 'Receita antiga', accountType: 'REVENUE' }, tenant.userId, t);
    await chartService.updateAccount(account.id, { name: 'Receita reclassificada', changeReason: 'Reclassificação do dia' }, tenant.userId, t);
    const versions = await chartService.listAccountVersions(account.id, t);
    assert.equal(versions.length, 2);

    const doDia = await resolveAccountVersionForEntry(account.id, tenant.companyId, inicioDeHoje(), t);
    assert.equal(doDia.id, versions[1].id, 'forma antiga: o instante 00:00 é anterior às duas versões e caía na primeira');
    const lancamento = await receivable(t, account.id, inicioDeHoje().toISOString());
    assert.equal(lancamento.chartOfAccountVersionId, versions[1].id, 'o lançamento que vence hoje grava a classificação vigente no dia');

    const deOntem = await resolveAccountVersionForEntry(account.id, tenant.companyId, ontem(), t);
    assert.equal(deOntem.id, versions[0].id, 'fato anterior à conta usa a primeira versão (a conta nunca teve outra classificação)');
  });
});

test('M4 §4: conta desativada hoje não recebe lançamento que vence hoje, mesmo com o vencimento antes do horário da desativação', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const account = await chartService.createAccount({ groupId: tenant.groupId, companyId: tenant.companyId, code: `DF.${uniqueSuffix()}`, name: 'Receita a encerrar', accountType: 'REVENUE' }, tenant.userId, t);
    await chartService.deactivateAccount(account.id, tenant.userId, t);
    await assert.rejects(
      receivable(t, account.id, inicioDeHoje().toISOString()),
      (err) => err.code === 'FINANCE_CHART_ACCOUNT_INACTIVE',
      'forma antiga: o vencimento de hoje (00:00) é anterior à desativação e a primeira versão, ativa, aceitava o lançamento'
    );
    const deOntem = await resolveAccountVersionForEntry(account.id, tenant.companyId, ontem(), t);
    assert.equal(deOntem.isActive, true, 'fato de ontem continua classificável');
  });
});
