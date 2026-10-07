'use strict';

const { ChangeOrder, Budget, Project } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'];

// DECISÃO DE ENGENHARIA (M6-06/M6-33): a fonte define 4 estados (DRAFT/PENDING_APPROVAL/
// APPROVED/REJECTED) mas não detalha um endpoint de "submeter" separado do de "criar". Como
// só existe UM endpoint de criação (`POST /construction/projects/:id/change-orders`), o
// Change Order já nasce em `PENDING_APPROVAL` (pronto para decisão) — `DRAFT` fica reservado
// para uma futura tela de rascunho no front que ainda não existe neste marco; o valor
// permanece no enum de status para não quebrar compatibilidade quando essa tela existir.

function assertEvidenceFileIds(evidenceFileIds) {
  if (evidenceFileIds === undefined || evidenceFileIds === null) return [];
  if (!Array.isArray(evidenceFileIds)) {
    throw AppError.badRequest('"evidenceFileIds" deve ser uma lista de IDs de arquivo.', 'CHANGE_ORDER_VALIDATION');
  }
  return evidenceFileIds;
}

async function createChangeOrder(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, reasonCode, description, budgetImpact, scheduleImpactDays, evidenceFileIds } = payload;
  if (!groupId || !companyId || !reasonCode || !description || budgetImpact === undefined || budgetImpact === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "reasonCode", "description" e "budgetImpact" são obrigatórios.',
      'CHANGE_ORDER_VALIDATION'
    );
  }
  const numericImpact = Number(budgetImpact);
  // FIX (auditoria Marco 6, ciclo 1 novo): só checava Number.isNaN — "budgetImpact": "Infinity"
  // não é NaN, passava o guard e, ao aprovar o Change Order, corrompia pra sempre
  // budget.baselineAmount/totalAmount e project.budgetAmount com o valor numérico 'Infinity'
  // (categoria 14 do catálogo de bugs: NaN/Infinity passando por guard de sinal).
  if (!Number.isFinite(numericImpact)) {
    throw AppError.badRequest('"budgetImpact" deve ser numérico.', 'CHANGE_ORDER_VALIDATION');
  }
  if (
    scheduleImpactDays !== undefined &&
    scheduleImpactDays !== null &&
    !Number.isFinite(Number(scheduleImpactDays))
  ) {
    throw AppError.badRequest('"scheduleImpactDays" deve ser numérico.', 'CHANGE_ORDER_VALIDATION');
  }

  const project = await Project.findByPk(projectId, { transaction });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');

  const changeOrder = await ChangeOrder.create(
    {
      groupId,
      companyId,
      projectId,
      reasonCode,
      description,
      budgetImpact: numericImpact,
      scheduleImpactDays: scheduleImpactDays != null ? Number(scheduleImpactDays) : null,
      evidenceFileIds: assertEvidenceFileIds(evidenceFileIds),
      status: 'PENDING_APPROVAL',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.change_order.create',
      entityType: 'ChangeOrder',
      entityId: changeOrder.id,
      afterJson: changeOrder.toJSON(),
      reason: `Change Order "${reasonCode}" criado para a obra ${projectId} (impacto: ${numericImpact}).`,
    },
    transaction
  );

  return changeOrder;
}

async function listChangeOrders(projectId, transaction) {
  return ChangeOrder.findAll({ where: { projectId }, order: [['created_at', 'DESC']], transaction });
}

async function getChangeOrder(id, transaction) {
  const changeOrder = await ChangeOrder.findByPk(id, { transaction });
  if (!changeOrder) throw AppError.notFound('Change Order não encontrado.', 'CHANGE_ORDER_NOT_FOUND');
  return changeOrder;
}

async function decideChangeOrder(id, payload, actorUserId, transaction) {
  const decision = String(payload && payload.decision ? payload.decision : '').toUpperCase();
  if (!['APPROVE', 'REJECT'].includes(decision)) {
    throw AppError.badRequest('"decision" deve ser "APPROVE" ou "REJECT".', 'CHANGE_ORDER_DECISION_INVALID');
  }

  // Lock pessimista no Change Order — mesmo padrão de concorrência já usado em
  // projects.service.js/budgets.service.js: duas decisões simultâneas sobre o mesmo Change
  // Order não podem ambas passar pela checagem de status PENDING_APPROVAL.
  const changeOrder = await ChangeOrder.findByPk(id, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!changeOrder) throw AppError.notFound('Change Order não encontrado.', 'CHANGE_ORDER_NOT_FOUND');
  if (changeOrder.status !== 'PENDING_APPROVAL') {
    // Achado numa auditoria do cliente (30/09/2026): mensagem sem enum cru em inglês.
    const labels = { DRAFT: 'rascunho', APPROVED: 'aprovado', REJECTED: 'rejeitado' };
    const statusLabel = labels[changeOrder.status] || changeOrder.status;
    throw AppError.conflict(
      `Este Change Order já está ${statusLabel} — só é possível decidir um Change Order ainda aguardando decisão.`,
      'CHANGE_ORDER_NOT_PENDING'
    );
  }

  const beforeJson = changeOrder.toJSON();

  if (decision === 'REJECT') {
    changeOrder.status = 'REJECTED';
    changeOrder.decidedBy = actorUserId || null;
    changeOrder.decidedAt = new Date();
    changeOrder.updatedBy = actorUserId || null;
    await changeOrder.save({ transaction });

    await registrarAuditoria(
      {
        groupId: changeOrder.groupId,
        companyId: changeOrder.companyId,
        actorUserId,
        action: 'construction.change_order.reject',
        entityType: 'ChangeOrder',
        entityId: changeOrder.id,
        beforeJson,
        afterJson: changeOrder.toJSON(),
        reason: `Change Order ${changeOrder.id} rejeitado.`,
      },
      transaction
    );

    return changeOrder;
  }

  // APPROVE: única forma de alterar valor de orçamento já aprovado (M6-17). Lock pessimista
  // também no orçamento — evita que dois Change Orders aplicados ao mesmo tempo sobre o mesmo
  // orçamento causem lost update na soma do impacto.
  const budget = await Budget.findOne({
    where: { projectId: changeOrder.projectId },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!budget || budget.status !== 'APPROVED') {
    throw AppError.conflict(
      'Só é possível aprovar Change Order de obra com orçamento já aprovado (baseline existente).',
      'CHANGE_ORDER_NO_APPROVED_BUDGET'
    );
  }

  const budgetBeforeJson = budget.toJSON();
  const newBaseline = Number(budget.baselineAmount) + Number(changeOrder.budgetImpact);
  if (newBaseline < 0) {
    throw AppError.badRequest('Aplicar este Change Order deixaria o orçamento com valor negativo.', 'CHANGE_ORDER_NEGATIVE_RESULT');
  }
  budget.baselineAmount = newBaseline;
  budget.totalAmount = newBaseline;
  budget.updatedBy = actorUserId || null;
  await budget.save({ transaction });

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 48, 2026-10-05): approveBudget (R46)
  // já sincroniza project.budgetAmount com o baseline aprovado, porque o contrato (TAB-0700)
  // trata projects.budget_amount como o orçamento oficial da obra — mas a ÚNICA outra forma de
  // mudar um baseline já aprovado (Change Order, M6-17) nunca replicava essa sincronização.
  // Depois do primeiro Change Order aprovado, project.budgetAmount ficava desatualizado em
  // relação ao baseline real, afetando qualquer leitura (ex.: projectHealth.service.js usa
  // project.budgetAmount como baselineBudget pra calcular margem/custo projetado).
  const project = await Project.findByPk(changeOrder.projectId, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (project) {
    project.budgetAmount = newBaseline;
    project.updatedBy = actorUserId || null;
    await project.save({ transaction });
  }

  changeOrder.status = 'APPROVED';
  changeOrder.decidedBy = actorUserId || null;
  changeOrder.decidedAt = new Date();
  changeOrder.updatedBy = actorUserId || null;
  await changeOrder.save({ transaction });

  await registrarAuditoria(
    {
      groupId: changeOrder.groupId,
      companyId: changeOrder.companyId,
      actorUserId,
      action: 'construction.change_order.approve',
      entityType: 'ChangeOrder',
      entityId: changeOrder.id,
      beforeJson,
      afterJson: changeOrder.toJSON(),
      reason: `Change Order ${changeOrder.id} aprovado — baseline do orçamento ${budget.id} alterada de ${budgetBeforeJson.baselineAmount} para ${newBaseline}.`,
    },
    transaction
  );

  return changeOrder;
}

module.exports = { createChangeOrder, listChangeOrders, getChangeOrder, decideChangeOrder, STATUSES };
