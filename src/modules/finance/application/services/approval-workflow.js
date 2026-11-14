'use strict';

/**
 * Núcleo da aprovação com retrato (Caderno §2 FIN-005, §5 approval_requests "Snapshot de aprovação" / approval_steps "Aprovadores";
 * Guia §4 `approvals.createFromRule(intent, approvalRule)`). Usado pelo pagamento, pelo caso de estorno (Guia §8) e pela reabertura de
 * período (Caderno §16, Guia §18 "fluxo CRITICAL"). Cada pedido guarda o retrato aprovável, o hash dele, o risco, o nº de aprovadores e a
 * versão da regra que os definiu; cada decisão é uma linha em approval_steps (única por aprovador). Ninguém aprova o próprio pedido
 * (salvo quando um parâmetro do livro permite, como financeiro.estorno.aprovador_distinto desligado).
 */
const { ApprovalRequest, ApprovalStep } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { assertRecentMfa } = require('../../../../features/users/mfa.service');
const { publishApprovalRequestCreated, publishApprovalStepDecided } = require('./finance-events.service');
const { computeSnapshotHash } = require('../../domain/payment-intent');

// Tipos com fluxo próprio: só as rotas dedicadas decidem (cada uma confere o que o livro manda além do voto).
const DEDICATED_TYPES = Object.freeze({
  PaymentIntent: 'POST /finance/payment-intents/:id/approve',
  LedgerReversal: 'POST /finance/reversal-cases/:id/approve',
  PeriodReopen: 'POST /finance/period-closures/reopen-requests/:id/approve',
});

// Nº de aprovações dos pedidos antigos (antes da coluna required_approvals): o mesmo de antes (DEC-004 1/1/2/2).
const LEGACY_REQUIRED_STEPS_BY_RISK = Object.freeze({ LOW: 1, MEDIUM: 1, HIGH: 2, CRITICAL: 2 });

function requiredApprovalsOf(request) {
  const n = Number(request.requiredApprovals);
  return Number.isInteger(n) && n >= 1 ? n : LEGACY_REQUIRED_STEPS_BY_RISK[request.riskLevel] || 1;
}

/** createFromRule — grava o pedido PENDING com o retrato, o hash e o que a regra decidiu. */
async function createApprovalFor(spec, actorUserId, transaction) {
  const snapshotHash = spec.snapshot ? computeSnapshotHash(spec.snapshot) : null;
  const request = await ApprovalRequest.create(
    {
      groupId: spec.groupId,
      companyId: spec.companyId,
      relatedEntityType: spec.relatedEntityType,
      relatedEntityId: spec.relatedEntityId,
      requestedByUserId: actorUserId,
      status: 'PENDING',
      riskLevel: spec.riskLevel,
      requiredApprovals: spec.requiredApprovals,
      ruleVersionId: spec.ruleVersionId || null,
      riskSource: spec.riskSource || null,
      snapshotJson: spec.snapshot || null,
      snapshotHash,
      reason: spec.reason || null,
      amount: spec.amount === undefined ? null : spec.amount,
      payloadJson: spec.payload || null,
      lockVersionAtRequest: spec.lockVersionAtRequest === undefined ? null : spec.lockVersionAtRequest,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  await publishApprovalRequestCreated(request, transaction);
  await registrarAuditoria(
    {
      groupId: request.groupId,
      companyId: request.companyId,
      actorUserId,
      action: 'finance.approval_request.create',
      entityType: 'ApprovalRequest',
      entityId: request.id,
      afterJson: request.toJSON(),
      reason: `Solicitação de aprovação criada para ${request.relatedEntityType} — risco ${request.riskLevel} (${request.riskSource || 'regra'}), ` +
        `${request.requiredApprovals} aprovação(ões), retrato ${snapshotHash ? snapshotHash.slice(0, 12) : 'sem hash'}.`,
    },
    transaction
  );
  return request;
}

async function getApprovalForUpdate(id, transaction) {
  const request = await ApprovalRequest.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!request) throw AppError.notFound('Solicitação de aprovação não encontrada.', 'FINANCE_APPROVAL_NOT_FOUND');
  return request;
}

function findPendingFor(relatedEntityType, relatedEntityId, transaction) {
  return ApprovalRequest.findOne({ where: { relatedEntityType, relatedEntityId, status: 'PENDING' }, transaction });
}

/** Pedidos ainda válidos (PENDING/APPROVED) das entidades informadas, com lock. */
function findActiveForUpdate(relatedEntityType, relatedEntityIds, transaction) {
  return ApprovalRequest.findAll({
    where: { relatedEntityType, relatedEntityId: relatedEntityIds, status: ['PENDING', 'APPROVED'] },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
}

async function listApprovers(approvalRequestId, transaction) {
  const steps = await ApprovalStep.findAll({ where: { approvalRequestId }, order: [['stepOrder', 'ASC']], transaction });
  return steps.map((s) => ({ approverUserId: s.approverUserId, decision: s.decision, decidedAt: s.decidedAt, stepOrder: s.stepOrder }));
}

/**
 * recordDecision — registra a decisão de uma pessoa no pedido (já travado pelo chamador). Devolve { step, approvalRequest, completed }:
 * `completed` = o pedido chegou a APPROVED (nº de aprovações exigido) ou REJECTED nesta decisão.
 * Opções: requireMfa (MFA recente do aprovador), allowRequester (o próprio solicitante pode decidir).
 */
async function recordDecision(request, { decision, approverUserId, requireMfa = false, allowRequester = false }, transaction) {
  const normalized = String(decision || '').toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(normalized)) {
    throw AppError.badRequest('O campo "decision" deve ser "APPROVED" ou "REJECTED".', 'FINANCE_APPROVAL_VALIDATION');
  }
  if (request.status === 'STALE') {
    throw AppError.conflict('Invalidada: o que foi pedido mudou depois do pedido; peça a aprovação de novo.', 'FINANCE_APPROVAL_STALE');
  }
  if (request.status !== 'PENDING') {
    throw AppError.conflict(`Esta solicitação já foi decidida (status "${request.status}").`, 'FINANCE_APPROVAL_ALREADY_DECIDED');
  }
  if (!allowRequester && String(request.requestedByUserId) === String(approverUserId)) {
    throw AppError.forbidden(
      'Quem solicitou não pode aprovar a própria solicitação (segregação de funções — maker-checker).',
      'FINANCE_APPROVAL_SELF_APPROVAL_FORBIDDEN'
    );
  }
  const existing = await ApprovalStep.findAll({ where: { approvalRequestId: request.id }, transaction });
  if (existing.some((s) => String(s.approverUserId) === String(approverUserId))) {
    throw AppError.conflict('Você já registrou uma decisão para esta solicitação.', 'FINANCE_APPROVAL_DUPLICATE_DECISION');
  }
  if (requireMfa) await assertRecentMfa(approverUserId, transaction);

  let step;
  try {
    step = await ApprovalStep.create(
      {
        groupId: request.groupId,
        companyId: request.companyId,
        approvalRequestId: request.id,
        approverUserId,
        stepOrder: existing.length + 1,
        decision: normalized,
        decidedAt: new Date(),
        createdBy: approverUserId || null,
        updatedBy: approverUserId || null,
      },
      { transaction }
    );
  } catch (/** @type {any} */ err) {
    // approval_steps_request_approver_uk fecha a corrida de dois cliques do mesmo aprovador.
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict('Você já registrou uma decisão para esta solicitação.', 'FINANCE_APPROVAL_DUPLICATE_DECISION');
    }
    throw err;
  }
  await publishApprovalStepDecided(step, transaction);

  const beforeJson = request.toJSON();
  const approvedCount = existing.filter((s) => s.decision === 'APPROVED').length + (normalized === 'APPROVED' ? 1 : 0);
  const required = requiredApprovalsOf(request);
  if (normalized === 'REJECTED') request.status = 'REJECTED';
  else if (approvedCount >= required) request.status = 'APPROVED';
  request.updatedBy = approverUserId || null;
  await request.save({ transaction });
  await registrarAuditoria(
    {
      groupId: request.groupId,
      companyId: request.companyId,
      actorUserId: approverUserId,
      action: 'finance.approval_step.decide',
      entityType: 'ApprovalStep',
      entityId: step.id,
      beforeJson,
      afterJson: { step: step.toJSON(), approvalRequest: request.toJSON() },
      reason: `Decisão "${normalized}" registrada (${approvedCount} de ${required} aprovação(ões) exigida(s), risco ${request.riskLevel}).`,
    },
    transaction
  );
  return { step, approvalRequest: request, completed: request.status !== 'PENDING', approvedCount, required };
}

/** Invalida o pedido (o retrato mudou): STALE, com auditoria. */
async function markStale(request, reason, actorUserId, transaction) {
  if (!['PENDING', 'APPROVED'].includes(request.status)) return false;
  const beforeJson = request.toJSON();
  request.status = 'STALE';
  request.updatedBy = actorUserId || null;
  await request.save({ transaction });
  await registrarAuditoria(
    {
      groupId: request.groupId,
      companyId: request.companyId,
      actorUserId,
      action: 'finance.approval_request.stale',
      entityType: 'ApprovalRequest',
      entityId: request.id,
      beforeJson,
      afterJson: request.toJSON(),
      reason,
    },
    transaction
  );
  return true;
}

module.exports = {
  DEDICATED_TYPES,
  LEGACY_REQUIRED_STEPS_BY_RISK,
  requiredApprovalsOf,
  createApprovalFor,
  getApprovalForUpdate,
  findPendingFor,
  findActiveForUpdate,
  listApprovers,
  recordDecision,
  markStale,
};
