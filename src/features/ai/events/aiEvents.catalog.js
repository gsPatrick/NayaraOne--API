'use strict';

/**
 * Catálogo dos eventos ai.* do livro (M9-D029): agregado, campos do payload (tipos de aiEvents.types.js) e chave de idempotência.
 * O payload é montado SÓ com estes campos, nunca com o objeto de origem: nada de prompt, documento ou dado pessoal sai. Mudar um
 * campo exige nova EVENT_VERSION.
 */
const EVENT_VERSION = 1;
const CLASSIFICATION = 'INTERNAL';

const CATALOG = Object.freeze({
  'ai.run.completed': {
    aggregateType: 'AiRun', aggregateField: 'runId',
    fields: {
      runId: 'uuid', agentCode: 'code', agentVersion: 'nullableInt', provider: 'nullableCode', model: 'nullableCode', routingPath: 'nullableCode',
      costAmount: 'nullableAmount', groundingStatus: 'nullableCode', latencyMs: 'nullableInt',
    },
    key: (p) => `ai.run.completed:${p.runId}`,
  },
  'ai.run.failed': {
    aggregateType: 'AiRun', aggregateField: 'runId',
    fields: { runId: 'uuid', agentCode: 'code', errorCode: 'nullableCode', blockedReason: 'nullableCode' },
    key: (p) => `ai.run.failed:${p.runId}`,
  },
  'ai.recommendation.created': {
    aggregateType: 'AiRecommendation', aggregateField: 'recommendationId',
    fields: { recommendationId: 'uuid', agentCode: 'code', type: 'code', riskLevel: 'code', targetUserId: 'nullableUuid' },
    key: (p) => `ai.recommendation.created:${p.recommendationId}`,
  },
  'ai.recommendation.accepted': {
    aggregateType: 'AiRecommendation', aggregateField: 'recommendationId',
    fields: { recommendationId: 'uuid', decidedBy: 'uuid', outcome: 'nullableCode' },
    key: (p) => `ai.recommendation.accepted:${p.recommendationId}`,
  },
  'ai.recommendation.rejected': {
    aggregateType: 'AiRecommendation', aggregateField: 'recommendationId',
    fields: { recommendationId: 'uuid', decidedBy: 'uuid', reasonCode: 'code' },
    key: (p) => `ai.recommendation.rejected:${p.recommendationId}`,
  },
  'ai.tool_call.blocked': {
    aggregateType: 'AiToolCall', aggregateField: 'toolCallId',
    fields: { toolCallId: 'uuid', runId: 'nullableCode', toolName: 'code', reason: 'code' },
    key: (p) => `ai.tool_call.blocked:${p.toolCallId}`,
  },
  'ai.budget.threshold_reached': {
    aggregateType: 'AiBudget', aggregateField: 'budgetId',
    fields: { budgetId: 'uuid', threshold: 'int', consumedPct: 'pct', periodStart: 'iso' },
    key: (p) => `ai.budget.threshold_reached:${p.budgetId}:${p.threshold}:${p.periodStart}`,
  },
  // Os três últimos campos vêm da M9-D021 (§5: hash do conteúdo e no máximo 120 caracteres do trecho já redigido).
  'ai.security.prompt_injection_detected': {
    aggregateType: 'AiRun', aggregateField: 'runId',
    fields: {
      runId: 'code', sourceId: 'code', origin: 'code', patternIds: 'codes', score: 'nullableScore', action: 'code',
      patternListVersion: 'nullableCode', contentHash: 'nullableHash', excerpt: 'nullableExcerpt',
    },
    key: (p) => `ai.security.prompt_injection_detected:${p.runId}:${p.sourceId}`,
  },
});

module.exports = { CATALOG, EVENT_VERSION, CLASSIFICATION };
