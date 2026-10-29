'use strict';

/** Linha de ai.ai_recommendations -> objeto da API (M9-D007). Datas em ISO; confiança em número. */
function toRecommendation(model) {
  const r = typeof model.get === 'function' ? model.get({ plain: true }) : model;
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return {
    id: r.id,
    aiRunId: r.aiRunId,
    agentCode: r.agentCode,
    relatedEntityType: r.relatedEntityType,
    relatedEntityId: r.relatedEntityId,
    recommendationType: r.recommendationType,
    title: r.title,
    rationale: r.rationale,
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    riskLevel: r.riskLevel,
    status: r.status,
    proposedAction: r.proposedAction,
    payload: r.payloadJson,
    decision: r.decision,
    decisionReason: r.decisionReason,
    decidedByUserId: r.decidedByUserId,
    decidedAt: iso(r.decidedAt),
    outcome: r.outcome,
    outcomeDetail: r.outcomeDetail,
    outcomeAt: iso(r.outcomeAt),
    targetUserId: r.targetUserId,
    dedupKey: r.dedupKey,
    createdAt: iso(r.created_at || r.createdAt),
  };
}

/** Retrato para a auditoria: sem justificativa, ação proposta nem payload (só os campos de controle). */
function auditSnapshot(rec) {
  const { id, agentCode, recommendationType, riskLevel, status, decision, decidedByUserId, outcome, targetUserId } = rec;
  return { id, agentCode, recommendationType, riskLevel, status, decision, decidedByUserId, outcome, targetUserId };
}

module.exports = { toRecommendation, auditSnapshot };
