'use strict';

// M9-D021 — evento ai.security.prompt_injection_detected no outbox, na mesma transação do run. O payload NUNCA leva o texto
// completo nem PII: só ids, padrões, score, ação, hash do conteúdo e no máximo 120 caracteres do trecho já redigido.

const { publishDomainEvent } = require('../../../engines/events/outbox');
const { PATTERN_LIST_VERSION, EXCERPT_MAX } = require('./injectionDetector');

const EVENT_TYPE = 'ai.security.prompt_injection_detected';

function toPayload(runId, d) {
  return {
    runId, sourceId: d.sourceId, origin: d.origin, patternIds: d.patternIds, score: d.score === undefined ? null : d.score,
    action: d.action, patternListVersion: PATTERN_LIST_VERSION, contentHash: d.contentHash, excerpt: String(d.excerpt || '').slice(0, EXCERPT_MAX),
  };
}

/** Publica um evento por detecção (ALLOW não gera). Repetir a mesma detecção do mesmo run não duplica (chave de idempotência). */
async function publishInjectionEvents(ctx, runId, detections, transaction) {
  const publicados = [];
  for (const d of detections || []) {
    if (!d || d.action === 'ALLOW') continue;
    const payload = toPayload(runId, d);
    publicados.push(await publishDomainEvent({
      groupId: ctx.groupId, companyId: ctx.companyId, aggregateType: 'AiRun', aggregateId: runId, eventType: EVENT_TYPE, payload,
      idempotencyKey: `${EVENT_TYPE}:${runId}:${d.sourceId}:${d.action}:${String(d.contentHash).slice(0, 16)}`,
    }, transaction));
  }
  return publicados;
}

module.exports = { publishInjectionEvents, EVENT_TYPE };
