'use strict';

// Dados de leitura dos agentes NAY do livro (M9-D035 e M9-D036): contratos a vencer, recebíveis vencidos e anomalias, criados pelos
// serviços e modelos reais da empresa informada (RLS do tenant). Todos sintéticos e com prefixo QA-M9.
const { Contract } = require('../../../src/models');
const financialEntries = require('../../../src/features/finance/financialEntries.service');
const anomalyCases = require('../../../src/features/finance/anomalyCases.service');
const { createTestCostCenter, createTestResultCenter, uniqueSuffix } = require('../../testHelpers');

const DIA = 86400000;
const emDias = (n) => new Date(Date.now() + n * DIA);

/** Contratos ATIVOS que terminam daqui a `dias` (um por item), com o valor informado. */
async function criarContratos(tenant, tx, itens) {
  const out = [];
  for (const { dias, valor } of itens) {
    out.push(await Contract.create({
      groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'SERVICE', status: 'ACTIVE', totalValue: valor, startsAt: emDias(-300), endsAt: emDias(dias),
      contractNumber: `QA-M9-${uniqueSuffix()}`,
    }, { transaction: tx }));
  }
  return out;
}

/** Lançamentos a receber (PENDING) com vencimento daqui a `dias` (negativo = vencido). */
async function criarRecebiveis(tenant, tx, itens) {
  const cc = await createTestCostCenter(tenant, tx);
  const rc = await createTestResultCenter(tenant, tx);
  const out = [];
  for (const { dias, valor } of itens) {
    out.push(await financialEntries.createFinancialEntry({
      groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: valor, description: `QA-M9 recebível ${uniqueSuffix()}`,
      costCenterId: cc.id, resultCenterId: rc.id, dueAt: emDias(dias).toISOString().slice(0, 10),
    }, tenant.userId, tx));
  }
  return out;
}

/** Lançamento a pagar (PENDING) para a prova de que a NAY nunca paga. */
async function criarPagavel(tenant, tx, { dias = 5, valor = 321.45 } = {}) {
  const cc = await createTestCostCenter(tenant, tx);
  return financialEntries.createFinancialEntry({
    groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: valor, description: `QA-M9 pagável ${uniqueSuffix()}`,
    costCenterId: cc.id, dueAt: emDias(dias).toISOString().slice(0, 10),
  }, tenant.userId, tx);
}

/** Caso de anomalia aberto, ligado a um lançamento. */
async function criarAnomalia(tenant, tx, { risco = 'HIGH', tipo = 'AMOUNT_OUTLIER', motivo = 'Valor fora do padrão do favorecido.' } = {}) {
  const e = await criarPagavel(tenant, tx, { valor: 777 });
  return anomalyCases.createAnomalyCase({
    groupId: tenant.groupId, companyId: tenant.companyId, caseType: tipo, riskLevel: risco, relatedEntityType: 'FinancialEntry', relatedEntityId: e.id, reason: motivo,
  }, tenant.userId, tx);
}

module.exports = { criarContratos, criarRecebiveis, criarPagavel, criarAnomalia, emDias };
