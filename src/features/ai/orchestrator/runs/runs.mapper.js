'use strict';

const C = require('./runs.constants');

const iso = (d) => (d ? new Date(d).toISOString() : null);
const six = (v) => (v === null || v === undefined ? null : String(v));

/** "A NAY não pôde concluir: <motivo>" para run bloqueado ou falho; os detalhes internos nunca saem. */
function blockedMessage(run) {
  if (run.status !== 'BLOCKED' && run.status !== 'FAILED') return null;
  const motivo = C.BLOCKED_MESSAGES[run.blockedReason] || C.BLOCKED_GENERIC;
  return `A NAY não pôde concluir: ${motivo}.`;
}

function toRun(model) {
  const r = model.get({ plain: true });
  return {
    id: r.id,
    agentId: r.agentId,
    agentCode: r.agentName,
    agentVersion: r.agentVersion,
    purpose: r.purpose,
    userId: r.userId,
    status: r.status,
    providerCode: r.providerCode,
    modelCode: r.modelCode,
    routingPath: r.routingPath,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    costAmount: six(r.costAmount),
    costCurrency: r.costCurrency,
    latencyMs: r.latencyMs,
    groundingStatus: r.groundingStatus,
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    blockedReason: r.blockedReason,
    errorCode: r.errorCode,
    message: blockedMessage(r),
    inputSummary: r.inputSummary,
    outputSummary: r.outputSummary,
    parentRunId: r.parentRunId,
    conversationId: r.conversationId,
    idempotencyKey: r.idempotencyKey,
    fallbackTrail: r.fallbackTrail || [],
    escalated: r.escalated,
    cached: r.cached,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    snapshotAt: iso(r.snapshotAt),
    correlationId: r.correlationId,
  };
}

function toSource(model) {
  const s = model.get({ plain: true });
  return {
    id: s.id,
    sourceType: s.sourceType,
    sourceRef: s.sourceRef,
    sourceVersion: s.sourceVersion,
    excerpt: s.excerpt,
    classification: s.classification,
    effectiveFrom: iso(s.effectiveFrom),
    effectiveUntil: iso(s.effectiveUntil),
    retrievedAt: iso(s.retrievedAt),
    relevanceScore: s.relevanceScore === null || s.relevanceScore === undefined ? null : Number(s.relevanceScore),
    usedInAnswer: s.usedInAnswer,
    statusAtRetrieval: s.statusAtRetrieval,
    contentHash: s.contentHash,
  };
}

/** O que a trilha de auditoria guarda de um run: sem resumos de texto (só o tamanho), nunca documento. */
function auditSnapshot(run) {
  return {
    status: run.status, agentCode: run.agentCode, agentVersion: run.agentVersion, routingPath: run.routingPath,
    providerCode: run.providerCode, modelCode: run.modelCode, tokensIn: run.tokensIn, tokensOut: run.tokensOut,
    costAmount: run.costAmount, groundingStatus: run.groundingStatus, blockedReason: run.blockedReason, errorCode: run.errorCode,
    startedAt: run.startedAt, finishedAt: run.finishedAt,
  };
}

module.exports = { toRun, toSource, auditSnapshot, blockedMessage };
