'use strict';

const iso = (d) => (d ? new Date(d).toISOString() : null);
const plain = (m) => (typeof m.get === 'function' ? m.get({ plain: true }) : m);

/** Linha de ai.evaluations -> objeto da API. */
function toEvaluation(model) {
  const e = plain(model);
  return {
    id: e.id,
    agentCode: e.agentCode,
    agentVersion: e.agentVersion,
    providerCode: e.providerCode,
    modelCode: e.modelCode,
    suite: e.suite,
    status: e.status,
    startedAt: iso(e.startedAt),
    finishedAt: iso(e.finishedAt),
    totals: e.totals,
    metrics: e.metrics,
    errorCode: e.errorCode,
    triggeredBy: e.triggeredBy,
    homologatedBy: e.homologatedBy,
    homologatedAt: iso(e.homologatedAt),
    homologationNote: e.homologationNote,
    createdAt: iso(e.created_at || e.createdAt),
  };
}

function toItem(model) {
  const i = plain(model);
  return {
    caseId: i.caseId,
    category: i.category,
    expected: i.expected,
    actualSummary: i.actualSummary,
    passed: i.passed,
    score: Number(i.score),
    latencyMs: i.latencyMs,
    costAmount: String(i.costAmount),
    details: i.details,
  };
}

/** Retrato para a auditoria: só campos de controle. */
function auditSnapshot(ev) {
  const { id, agentCode, agentVersion, suite, status, triggeredBy, homologatedBy, homologatedAt } = ev;
  return { id, agentCode, agentVersion, suite, status, triggeredBy, homologatedBy, homologatedAt };
}

module.exports = { toEvaluation, toItem, auditSnapshot, iso };
