'use strict';

const { AiRecommendation, AiRun } = require('../../../models');
const E = require('./recommendation.errors');
const V = require('./recommendation.validation');
const { toRecommendation } = require('./recommendation.mapper');
const { readRecommendationParams } = require('./recommendation.params');
const { publishRecommendationEvent, auditRecommendation } = require('./recommendation.events');
const { EVENTS } = require('./recommendation.constants');
const support = require('../readmodels/recommendationSupport.readmodel');

/**
 * Cria uma recomendação PENDING. Quem cria é a NAY (identidade de serviço) ou uma regra; a criação não decide nada.
 * Duplicidade: a mesma sugestão (agente + entidade + tipo + dia) já pendente devolve a existente (`replayed: true`) sem novo
 * evento. A linha, a auditoria e o evento ai.recommendation.created saem na mesma transação.
 */
async function createRecommendation(ctx, data, transaction) {
  V.ctxOk(ctx);
  const params = await readRecommendationParams(ctx, transaction);
  const d = V.parseCreate(data, params);
  if (d.aiRunId && !(await AiRun.findOne({ where: { id: d.aiRunId, companyId: ctx.companyId }, transaction }))) throw E.invalid('A execução informada não foi encontrada.');
  if (d.targetUserId && !(await support.userBelongsToCompany(d.targetUserId, ctx.companyId, transaction))) throw E.invalid('O destinatário informado não pertence a esta empresa.');
  const key = V.dedupKey(d);
  await support.acquireDedupLock(ctx.companyId, key, transaction);
  const existing = await AiRecommendation.findOne({ where: { companyId: ctx.companyId, dedupKey: key, status: 'PENDING' }, transaction });
  if (existing) return { recommendation: toRecommendation(existing), replayed: true };
  const row = await AiRecommendation.create({
    groupId: ctx.groupId, companyId: ctx.companyId, aiRunId: d.aiRunId, agentCode: d.agentCode, relatedEntityType: d.relatedEntityType,
    relatedEntityId: d.relatedEntityId, recommendationType: d.recommendationType, title: d.title, rationale: d.rationale,
    confidence: d.confidence, riskLevel: d.riskLevel, proposedAction: d.proposedAction, payloadJson: d.payload, targetUserId: d.targetUserId,
    dedupKey: key, status: 'PENDING', createdBy: ctx.userId || null, updatedBy: ctx.userId || null,
  }, { transaction });
  const rec = toRecommendation(row);
  await auditRecommendation(ctx, 'ai.recommendation.created', rec, null, 'Recomendação da NAY criada.', transaction);
  await publishRecommendationEvent(ctx, EVENTS.created, rec, transaction);
  return { recommendation: rec, replayed: false };
}

module.exports = { createRecommendation };
