'use strict';

const { CostCenter } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 13, Frente A, 09/10/2026): costCenterId era
 * aceito cru do payload, sem NENHUMA validação de existência/tenant, em createStageMeasurement,
 * createBudgetLine/updateBudgetLine e createProject/updateProject. Cenário concreto: usuário da
 * Empresa A informa um costCenterId que pertence a um CostCenter da Empresa B — o valor só é de
 * fato usado mais adiante (ex.: stageMeasurements.service.js#createPayableForMeasurement ->
 * financialEntriesService.createFinancialEntry, que só valida PRESENÇA do campo, nunca seu
 * tenant), gerando um lançamento financeiro real vinculado a um centro de custo de outra
 * empresa. RLS não ajuda aqui: o INSERT final roda com o companyId correto do lançamento — só o
 * costCenterId REFERENCIADO é que pertence a outro tenant.
 */
async function assertCostCenterBelongsToCompany(costCenterId, companyId, transaction) {
  if (!costCenterId) return;
  const costCenter = await CostCenter.findByPk(costCenterId, { transaction });
  if (!costCenter) {
    throw AppError.notFound('Centro de custo não encontrado.', 'COST_CENTER_NOT_FOUND');
  }
  if (costCenter.companyId !== companyId) {
    throw AppError.badRequest('Este centro de custo não pertence à empresa informada.', 'COST_CENTER_COMPANY_MISMATCH');
  }
}

module.exports = { assertCostCenterBelongsToCompany };
