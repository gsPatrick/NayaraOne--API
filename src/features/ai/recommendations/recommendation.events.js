'use strict';

const { publishDomainEvent } = require('../../../engines/events/outbox');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { auditSnapshot } = require('./recommendation.mapper');

/**
 * Evento ai.recommendation.created/accepted/rejected na MESMA transação da recomendação (outbox). O payload leva só ids e
 * estado, nunca a justificativa nem os argumentos da ação proposta.
 */
async function publishRecommendationEvent(ctx, eventType, rec, transaction) {
  return publishDomainEvent({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    aggregateType: 'AiRecommendation',
    aggregateId: rec.id,
    eventType,
    payload: {
      recommendationId: rec.id, agentCode: rec.agentCode, recommendationType: rec.recommendationType, riskLevel: rec.riskLevel,
      status: rec.status, decision: rec.decision, decidedByUserId: rec.decidedByUserId, targetUserId: rec.targetUserId, aiRunId: rec.aiRunId,
    },
    idempotencyKey: `${eventType}:${rec.id}`,
  }, transaction);
}

/** Trilha antes/depois (campos de controle). O ator é a pessoa; a NAY (identidade de serviço) fica sem ator. */
async function auditRecommendation(ctx, action, rec, before, reason, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    actorUserId: ctx.serviceIdentity ? null : ctx.userId || null,
    action,
    entityType: 'AiRecommendation',
    entityId: rec.id,
    beforeJson: before ? auditSnapshot(before) : { registro: 'inexistente' },
    afterJson: auditSnapshot(rec),
    reason,
  }, transaction);
}

module.exports = { publishRecommendationEvent, auditRecommendation };
