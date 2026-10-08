'use strict';

const { CostCenter } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

async function createCostCenter(payload, actorUserId, transaction) {
  const { groupId, companyId, code, name } = payload;
  if (!groupId || !companyId || !code || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId", "code" e "name" são obrigatórios.', 'FINANCE_COST_CENTER_VALIDATION');
  }
  const costCenter = await CostCenter.create(
    { groupId, companyId, code, name, createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.cost_center.create',
      entityType: 'CostCenter',
      entityId: costCenter.id,
      afterJson: costCenter.toJSON(),
      reason: `Centro de custo "${costCenter.code} — ${costCenter.name}" criado.`,
    },
    transaction
  );

  return costCenter;
}

async function listCostCenters(transaction) {
  return CostCenter.findAll({ order: [['code', 'ASC']], transaction });
}

async function getCostCenter(id, transaction) {
  const costCenter = await CostCenter.findByPk(id, { transaction });
  if (!costCenter) throw AppError.notFound('Centro de custo não encontrado.', 'FINANCE_COST_CENTER_NOT_FOUND');
  return costCenter;
}

async function updateCostCenter(id, payload, actorUserId, transaction) {
  const costCenter = await getCostCenter(id, transaction);
  const beforeJson = costCenter.toJSON();
  const { code, name } = payload;
  if (code !== undefined) costCenter.code = code;
  if (name !== undefined) costCenter.name = name;
  costCenter.updatedBy = actorUserId || null;
  await costCenter.save({ transaction });

  await registrarAuditoria(
    {
      groupId: costCenter.groupId,
      companyId: costCenter.companyId,
      actorUserId,
      action: 'finance.cost_center.update',
      entityType: 'CostCenter',
      entityId: costCenter.id,
      beforeJson,
      afterJson: costCenter.toJSON(),
      reason: `Centro de custo "${costCenter.code}" atualizado.`,
    },
    transaction
  );

  return costCenter;
}

async function deleteCostCenter(id, actorUserId, transaction) {
  const costCenter = await getCostCenter(id, transaction);
  const beforeJson = costCenter.toJSON();
  costCenter.deletedBy = actorUserId || null;
  await costCenter.save({ transaction });
  await costCenter.destroy({ transaction });

  await registrarAuditoria(
    {
      groupId: costCenter.groupId,
      companyId: costCenter.companyId,
      actorUserId,
      action: 'finance.cost_center.delete',
      entityType: 'CostCenter',
      entityId: costCenter.id,
      beforeJson,
      reason: `Centro de custo "${costCenter.code}" excluído.`,
    },
    transaction
  );

  return { id };
}

// BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07; contrato, Centro Financeiro
// BLINDADO v1, §4: "Centro de custo obrigatório para despesa"): várias origens automáticas de
// despesa (recebimento de materiais, custos de pós-obra, utilidades, etc.) criavam lançamentos
// PAYABLE sem nenhum centro de custo — a validação nova em createFinancialEntry passou a
// bloquear todas elas. Em vez de exigir que cada módulo colete esse dado de um fluxo que não
// tem como pedir (webhook, job automático), resolve/cria (uma única vez por empresa, lazy) um
// centro de custo dedicado por domínio — mesmo padrão de auto-seed já usado em
// slaRules.service.js (getActiveSlaDaysMap) e marginRules.service.js.
async function getOrCreateDefaultCostCenter(groupId, companyId, code, name, transaction) {
  const existing = await CostCenter.findOne({ where: { groupId, companyId, code }, transaction });
  if (existing) return existing;
  return CostCenter.create({ groupId, companyId, code, name }, { transaction });
}

module.exports = {
  createCostCenter,
  listCostCenters,
  getCostCenter,
  updateCostCenter,
  deleteCostCenter,
  getOrCreateDefaultCostCenter,
};
