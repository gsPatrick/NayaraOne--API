'use strict';

// M9-D021 — evento ai.security.prompt_injection_detected no outbox, na mesma transação do run. O payload NUNCA leva o texto
// completo nem PII: só ids, padrões, score, ação, hash do conteúdo e no máximo 120 caracteres do trecho já redigido.

const { publishInjectionDetected } = require('../events');
const { PATTERN_LIST_VERSION, EXCERPT_MAX } = require('./injectionDetector');
const { observe } = require('../observability/observe');

const EVENT_TYPE = 'ai.security.prompt_injection_detected';

function toDetection(d) {
  return {
    sourceId: d.sourceId, origin: d.origin, patternIds: d.patternIds, score: d.score === undefined ? null : d.score, action: d.action,
    patternListVersion: PATTERN_LIST_VERSION, contentHash: d.contentHash, excerpt: String(d.excerpt || '').slice(0, EXCERPT_MAX),
  };
}

/** Publica um evento por detecção (ALLOW não gera), pela publicação única de events/ (M9-D029). Repetir a mesma detecção (run + fonte) não duplica. */
async function publishInjectionEvents(ctx, runId, detections, transaction) {
  const publicados = [];
  for (const d of detections || []) {
    if (!d || d.action === 'ALLOW') continue;
    publicados.push(await publishInjectionDetected(ctx, runId, toDetection(d), transaction));
    await observe(ctx, transaction, (m) => m.injectionDetected(d.origin, `${runId}:${d.sourceId}`)); // M9-D047: ai_injection_detected_total
  }
  return publicados;
}

module.exports = { publishInjectionEvents, EVENT_TYPE };
