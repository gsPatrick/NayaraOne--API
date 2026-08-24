'use strict';

const { ApprovalRequest, ApprovalStep, BankAccount, FinancialEntry, Commission, CommissionInstallment, OwnerRepass } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishApprovalRequestCreated, publishApprovalStepDecided } = require('./financeEvents.service');

// Motor genérico de dupla aprovação (maker-checker) — 03_MOTORES_TRANSVERSAIS.md: "Quem cria
// não aprova; quem aprova não altera; quem executa valida o hash aprovado."
//
// `finance.approval_requests` é polimórfico (`related_entity_type` + `related_entity_id`) e
// NÃO tem uma coluna de snapshot/hash (ver nota em financeAntifraud.service.js). A proteção
// equivalente aqui é lock otimista: quem decide pode informar `expectedLockVersion` (o
// lock_version que viu ao revisar o pedido); se a entidade mudou desde então, a decisão é
// recusada com FINANCE_APPROVAL_STALE em vez de aprovar algo que já não é mais o que foi visto.
const ENTITY_MODELS = {
  BankAccount,
  FinancialEntry,
  Commission,
  CommissionInstallment,
  OwnerRepass,
};

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
// Nº de aprovações independentes exigidas por nível de risco. Não há essa configuração no
// documento/schema (approval_requests não tem uma coluna "required_steps") — é uma decisão de
// implementação razoável e documentada aqui, não um valor extraído de alguma fonte.
const REQUIRED_STEPS_BY_RISK = { LOW: 1, MEDIUM: 1, HIGH: 2, CRITICAL: 2 };

async function createApprovalRequest(payload, actorUserId, transaction) {
  const { groupId, companyId, relatedEntityType, relatedEntityId, riskLevel } = payload;
  if (!groupId || !companyId || !relatedEntityType || !relatedEntityId) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "relatedEntityType" e "relatedEntityId" são obrigatórios.',
      'FINANCE_APPROVAL_VALIDATION'
    );
  }
  const normalizedRisk = riskLevel ? String(riskLevel).toUpperCase() : 'MEDIUM';
  if (!RISK_LEVELS.includes(normalizedRisk)) {
    throw AppError.badRequest(`O campo "riskLevel" deve ser um de: ${RISK_LEVELS.join(', ')}.`, 'FINANCE_APPROVAL_VALIDATION');
  }

  const existingPending = await ApprovalRequest.findOne({
    where: { relatedEntityType, relatedEntityId, status: 'PENDING' },
    transaction,
  });
  if (existingPending) {
    throw AppError.conflict('Já existe uma solicitação de aprovação pendente para esta entidade.', 'FINANCE_APPROVAL_ALREADY_PENDING', {
      existingId: existingPending.id,
    });
  }

  const approvalRequest = await ApprovalRequest.create(
    {
      groupId,
      companyId,
      relatedEntityType,
      relatedEntityId,
      requestedByUserId: actorUserId,
      status: 'PENDING',
      riskLevel: normalizedRisk,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishApprovalRequestCreated(approvalRequest, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.approval_request.create',
      entityType: 'ApprovalRequest',
      entityId: approvalRequest.id,
      afterJson: approvalRequest.toJSON(),
      reason: `Solicitação de aprovação criada para ${relatedEntityType} (risco ${normalizedRisk}).`,
    },
    transaction
  );

  return approvalRequest;
}

async function listApprovalRequests(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.relatedEntityType) where.relatedEntityType = filters.relatedEntityType;
  if (filters.relatedEntityId) where.relatedEntityId = filters.relatedEntityId;
  return ApprovalRequest.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getApprovalRequest(id, transaction) {
  const approvalRequest = await ApprovalRequest.findByPk(id, { transaction });
  if (!approvalRequest) throw AppError.notFound('Solicitação de aprovação não encontrada.', 'FINANCE_APPROVAL_NOT_FOUND');
  return approvalRequest;
}

/**
 * decideApprovalStep — maker-checker: quem solicitou não pode decidir a própria solicitação.
 * `expectedLockVersion` (opcional) é comparado contra o lock_version ATUAL da entidade
 * relacionada — se divergir, a entidade mudou depois que o aprovador a revisou e a decisão é
 * recusada (equivalente a invalidar por snapshot alterado, sem precisar de coluna de hash).
 */
async function decideApprovalStep(approvalRequestId, payload, approverUserId, transaction) {
  const { decision, expectedLockVersion } = payload;
  const normalizedDecision = String(decision || '').toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(normalizedDecision)) {
    throw AppError.badRequest('O campo "decision" deve ser "APPROVED" ou "REJECTED".', 'FINANCE_APPROVAL_VALIDATION');
  }

  const approvalRequest = await getApprovalRequest(approvalRequestId, transaction);
  if (approvalRequest.status !== 'PENDING') {
    throw AppError.conflict(`Esta solicitação já foi decidida (status "${approvalRequest.status}").`, 'FINANCE_APPROVAL_ALREADY_DECIDED');
  }
  if (approvalRequest.requestedByUserId === approverUserId) {
    throw AppError.forbidden(
      'Quem solicitou a aprovação não pode aprovar a própria solicitação (segregação de funções — maker-checker).',
      'FINANCE_APPROVAL_SELF_APPROVAL_FORBIDDEN'
    );
  }

  const existingSteps = await ApprovalStep.findAll({ where: { approvalRequestId }, transaction });
  if (existingSteps.some((s) => s.approverUserId === approverUserId)) {
    throw AppError.conflict('Você já registrou uma decisão para esta solicitação.', 'FINANCE_APPROVAL_DUPLICATE_DECISION');
  }

  if (expectedLockVersion !== undefined) {
    const Model = ENTITY_MODELS[approvalRequest.relatedEntityType];
    if (Model) {
      const entity = await Model.findByPk(approvalRequest.relatedEntityId, { transaction });
      if (entity && 'lockVersion' in entity.dataValues && Number(entity.lockVersion) !== Number(expectedLockVersion)) {
        throw AppError.conflict(
          'A entidade relacionada foi alterada desde que esta solicitação foi revisada — aprovação recusada por segurança (dado desatualizado).',
          'FINANCE_APPROVAL_STALE'
        );
      }
    }
  }

  const step = await ApprovalStep.create(
    {
      groupId: approvalRequest.groupId,
      companyId: approvalRequest.companyId,
      approvalRequestId,
      approverUserId,
      stepOrder: existingSteps.length + 1,
      decision: normalizedDecision,
      decidedAt: new Date(),
      createdBy: approverUserId || null,
      updatedBy: approverUserId || null,
    },
    { transaction }
  );

  await publishApprovalStepDecided(step, transaction);

  const beforeJson = approvalRequest.toJSON();
  if (normalizedDecision === 'REJECTED') {
    approvalRequest.status = 'REJECTED';
  } else {
    const approvedCount = existingSteps.filter((s) => s.decision === 'APPROVED').length + 1;
    const required = REQUIRED_STEPS_BY_RISK[approvalRequest.riskLevel] || 1;
    if (approvedCount >= required) {
      approvalRequest.status = 'APPROVED';
    }
  }
  approvalRequest.updatedBy = approverUserId || null;
  await approvalRequest.save({ transaction });

  await registrarAuditoria(
    {
      groupId: approvalRequest.groupId,
      companyId: approvalRequest.companyId,
      actorUserId: approverUserId,
      action: 'finance.approval_step.decide',
      entityType: 'ApprovalStep',
      entityId: step.id,
      beforeJson,
      afterJson: { step: step.toJSON(), approvalRequest: approvalRequest.toJSON() },
      reason: `Decisão "${normalizedDecision}" registrada para solicitação de aprovação (etapa ${step.stepOrder}).`,
    },
    transaction
  );

  return { step, approvalRequest };
}

/**
 * isApprovalRequestApproved — helper pra outros services (ex.: financialEntries.settleFinancialEntry)
 * checarem, antes de executar uma ação sensível, se já existe aprovação concluída pra ela.
 * Uso opcional — este módulo não força nenhum outro service a exigir aprovação automaticamente,
 * já que o schema não define um limiar de valor/risco que dispare isso obrigatoriamente.
 */
async function isApprovalRequestApproved(relatedEntityType, relatedEntityId, transaction) {
  const approvalRequest = await ApprovalRequest.findOne({
    where: { relatedEntityType, relatedEntityId, status: 'APPROVED' },
    transaction,
  });
  return Boolean(approvalRequest);
}

module.exports = {
  createApprovalRequest,
  listApprovalRequests,
  getApprovalRequest,
  decideApprovalStep,
  isApprovalRequestApproved,
  RISK_LEVELS,
  REQUIRED_STEPS_BY_RISK,
};
