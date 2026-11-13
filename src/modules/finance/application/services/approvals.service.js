'use strict';

const { ApprovalRequest, ApprovalStep } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { ENTITY_MODELS, resolveRelatedEntityLabels } = require('./approval-related-entities');
const workflow = require('./approval-workflow');
const { centsText } = require('../../domain/payment-intent');
const { buildEntitySnapshot, resolveSubjectPolicy, snapshotStillMatches, approvalRequiresMfa } = require('./approval-subject');

// Motor genérico de dupla aprovação (maker-checker) — 03_MOTORES_TRANSVERSAIS.md: "Quem cria não aprova; quem aprova não altera; quem
// executa valida o hash aprovado." Caderno M4 §2 FIN-005: "Limites vêm do Motor de Regras; aprovação usa snapshot/hash".
//
// M4PG (verificação independente do Marco 4, sondas V2-P2 e P9): o risco e o nº de aprovadores NÃO vêm mais do pedido. São calculados
// pelo valor da entidade (REG-FIN-002 ou as faixas da DEC-004 — approval-subject.js); o pedido guarda o retrato da entidade e o hash
// dele, conferidos de novo na decisão (além do lock_version capturado no servidor, achado A10). `riskLevel` no corpo é ignorado.

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
// Compatibilidade de leitura: o nº de aprovações dos pedidos antigos (sem required_approvals). Pedidos novos usam a regra.
const REQUIRED_STEPS_BY_RISK = workflow.LEGACY_REQUIRED_STEPS_BY_RISK;

async function createApprovalRequest(payload, actorUserId, transaction) {
  const { groupId, companyId, relatedEntityType, relatedEntityId } = payload;
  if (!groupId || !companyId || !relatedEntityType || !relatedEntityId) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "relatedEntityType" e "relatedEntityId" são obrigatórios.',
      'FINANCE_APPROVAL_VALIDATION'
    );
  }
  if (workflow.DEDICATED_TYPES[relatedEntityType]) {
    throw AppError.badRequest(
      `Pedido de aprovação de ${relatedEntityType} nasce do próprio fluxo (${workflow.DEDICATED_TYPES[relatedEntityType]}), não por aqui.`,
      'FINANCE_APPROVAL_USE_DEDICATED_FLOW'
    );
  }

  // E1 (revisão independente, 18/10/2026): o tipo precisa ser um dos aprováveis e a entidade precisa existir NESTA empresa (a busca roda
  // sob o RLS do tenant, então uma entidade de outra empresa simplesmente não é encontrada).
  const RelatedModel = ENTITY_MODELS[relatedEntityType];
  if (!RelatedModel) {
    throw AppError.badRequest(
      `O campo "relatedEntityType" deve ser um de: ${Object.keys(ENTITY_MODELS).join(', ')}.`,
      'FINANCE_APPROVAL_VALIDATION'
    );
  }
  const entity = await RelatedModel.findOne({ where: { id: relatedEntityId, companyId }, transaction });
  if (!entity) throw AppError.notFound('A entidade a ser aprovada não foi encontrada nesta empresa.', 'FINANCE_APPROVAL_RELATED_ENTITY_NOT_FOUND');
  if (relatedEntityType === 'FinancialEntry') await require('./payment-anomaly-gate').evaluateAndAssertPreparable(entity, transaction, actorUserId); // §17 + DEC-007 (achado bloqueante; DI-DEC007-5)

  let existingPending = await workflow.findPendingFor(relatedEntityType, relatedEntityId, transaction);
  // R2 (reconferência 20/10/2026): um pedido pendente cuja entidade mudou depois dele (versão ou retrato diferente) não trava um novo.
  const changedSinceRequest = (req) =>
    (req.lockVersionAtRequest !== null && req.lockVersionAtRequest !== undefined && 'lockVersion' in entity.dataValues
      && Number(req.lockVersionAtRequest) !== Number(entity.lockVersion)) || !snapshotStillMatches(req, relatedEntityType, entity);
  if (existingPending && changedSinceRequest(existingPending)) {
    await workflow.markStale(existingPending, 'Invalidada: a entidade foi alterada depois do pedido.', actorUserId, transaction);
    existingPending = null;
  }
  if (existingPending) {
    throw AppError.conflict('Já existe uma solicitação de aprovação pendente para esta entidade.', 'FINANCE_APPROVAL_ALREADY_PENDING', {
      existingId: existingPending.id,
    });
  }

  const tenant = { groupId, companyId };
  const policy = await resolveSubjectPolicy(relatedEntityType, entity, tenant, transaction);
  return workflow.createApprovalFor(
    {
      groupId,
      companyId,
      relatedEntityType,
      relatedEntityId,
      riskLevel: policy.riskLevel,
      requiredApprovals: policy.requiredApprovals,
      ruleVersionId: policy.ruleVersionId,
      riskSource: policy.riskSource,
      snapshot: buildEntitySnapshot(relatedEntityType, entity),
      amount: policy.amountCents === null ? null : centsText(policy.amountCents),
      // A10: a versão é capturada aqui, no servidor — nunca confiada do decisor.
      lockVersionAtRequest: 'lockVersion' in entity.dataValues ? Number(entity.lockVersion) : null,
    },
    actorUserId,
    transaction
  );
}

async function listApprovalRequests(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.relatedEntityType) where.relatedEntityType = filters.relatedEntityType;
  if (filters.relatedEntityId) where.relatedEntityId = filters.relatedEntityId;
  const requests = await ApprovalRequest.findAll({ where, order: [['created_at', 'DESC']], transaction });
  return resolveRelatedEntityLabels(requests, transaction);
}

async function getApprovalRequest(id, transaction) {
  const approvalRequest = await ApprovalRequest.findByPk(id, { transaction });
  if (!approvalRequest) throw AppError.notFound('Solicitação de aprovação não encontrada.', 'FINANCE_APPROVAL_NOT_FOUND');
  return approvalRequest;
}

/**
 * decideApprovalStep — maker-checker: quem solicitou não decide. A entidade precisa continuar igual ao retrato do pedido (hash) e à versão
 * capturada no servidor (A10); `expectedLockVersion`, se vier, também precisa bater (defesa em profundidade). Rejeitar um pedido
 * desatualizado é sempre permitido. MFA recente: HIGH/CRITICAL sempre, MEDIUM conforme pagamentos.mfa.aprovacao_medio (DEC-058).
 */
async function decideApprovalStep(approvalRequestId, payload, approverUserId, transaction) {
  const { decision, expectedLockVersion } = payload;
  const normalizedDecision = String(decision || '').toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(normalizedDecision)) {
    throw AppError.badRequest('O campo "decision" deve ser "APPROVED" ou "REJECTED".', 'FINANCE_APPROVAL_VALIDATION');
  }
  const approvalRequest = await workflow.getApprovalForUpdate(approvalRequestId, transaction);
  if (workflow.DEDICATED_TYPES[approvalRequest.relatedEntityType]) {
    throw AppError.conflict(
      `Esta aprovação tem fluxo próprio: use ${workflow.DEDICATED_TYPES[approvalRequest.relatedEntityType]}.`,
      'FINANCE_APPROVAL_USE_DEDICATED_FLOW'
    );
  }
  if (approvalRequest.status === 'STALE') {
    throw AppError.conflict('Invalidada: o lançamento foi alterado depois do pedido; peça a aprovação de novo.', 'FINANCE_APPROVAL_STALE');
  }

  const RelatedModel = ENTITY_MODELS[approvalRequest.relatedEntityType];
  const entity = RelatedModel ? await RelatedModel.findByPk(approvalRequest.relatedEntityId, { transaction }) : null;
  if (entity && approvalRequest.status === 'PENDING' && normalizedDecision !== 'REJECTED') {
    const hasVersion = 'lockVersion' in entity.dataValues;
    const currentLockVersion = hasVersion ? Number(entity.lockVersion) : null;
    const staleAgainstSnapshot = hasVersion && approvalRequest.lockVersionAtRequest !== null && approvalRequest.lockVersionAtRequest !== undefined
      && Number(approvalRequest.lockVersionAtRequest) !== currentLockVersion;
    const staleAgainstClient = hasVersion && expectedLockVersion !== undefined && Number(expectedLockVersion) !== currentLockVersion;
    const staleAgainstHash = !snapshotStillMatches(approvalRequest, approvalRequest.relatedEntityType, entity);
    if (staleAgainstSnapshot || staleAgainstClient || staleAgainstHash) {
      throw AppError.conflict('O lançamento foi alterado depois do pedido de aprovação; peça a aprovação de novo.', 'FINANCE_APPROVAL_STALE');
    }
  }

  const requireMfa = normalizedDecision === 'APPROVED'
    && (await approvalRequiresMfa(approvalRequest.riskLevel, { groupId: approvalRequest.groupId, companyId: approvalRequest.companyId }, transaction));
  const { step } = await workflow.recordDecision(approvalRequest, { decision: normalizedDecision, approverUserId, requireMfa }, transaction);
  return { step, approvalRequest };
}

/**
 * isApprovalRequestApproved — outros serviços (ex.: a baixa de um PAYABLE sem intenção) checam se já existe aprovação concluída para a
 * entidade.
 */
async function isApprovalRequestApproved(relatedEntityType, relatedEntityId, transaction) {
  const approvalRequest = await ApprovalRequest.findOne({ where: { relatedEntityType, relatedEntityId, status: 'APPROVED' }, transaction });
  return Boolean(approvalRequest);
}

/**
 * listApprovedDeciders — quem decidiu (APPROVED) as solicitações ainda válidas (não STALE) de uma entidade. Usado pela baixa manual com
 * comprovante (F03/A4): quem anexou o comprovante não pode ser quem aprovou a exceção.
 */
async function listApprovedDeciders(relatedEntityType, relatedEntityId, transaction) {
  const approved = await ApprovalRequest.findAll({ where: { relatedEntityType, relatedEntityId, status: 'APPROVED' }, transaction });
  if (approved.length === 0) return [];
  const steps = await ApprovalStep.findAll({ where: { approvalRequestId: approved.map((r) => r.id), decision: 'APPROVED' }, transaction });
  return steps.map((s) => s.approverUserId).filter(Boolean);
}

/**
 * markApprovalRequestsStale — FIN-005 "Alteração após aprovação deve invalidar efetivamente a decisão": edição real (do lançamento ou do
 * favorecido) → as aprovações APPROVED/PENDING viram STALE e nunca mais contam em isApprovalRequestApproved. O ponto de invalidação é a
 * edição, não a comparação no consumo: a baixa parcial muda o lockVersion e não pode invalidar um fluxo legítimo (ADV-F21).
 */
async function markApprovalRequestsStale(relatedEntityType, relatedEntityId, reason, actorUserId, transaction) {
  const requests = await ApprovalRequest.findAll({
    where: { relatedEntityType, relatedEntityId, status: ['APPROVED', 'PENDING'] },
    transaction,
  });
  for (const request of requests) await workflow.markStale(request, reason, actorUserId, transaction);
  return requests.length;
}

module.exports = {
  createApprovalRequest,
  listApprovalRequests,
  getApprovalRequest,
  decideApprovalStep,
  isApprovalRequestApproved,
  listApprovedDeciders,
  markApprovalRequestsStale,
  RISK_LEVELS,
  REQUIRED_STEPS_BY_RISK,
};
