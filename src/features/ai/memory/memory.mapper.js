'use strict';

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Linha de ai.memories -> objeto da API (M9-D009). Datas em ISO. */
function toMemory(model) {
  const r = typeof model.get === 'function' ? model.get({ plain: true }) : model;
  return {
    id: r.id,
    memoryType: r.memoryType,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    scope: r.scope,
    agentCode: r.agentCode,
    ownerUserId: r.ownerUserId,
    value: r.value,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    classification: r.classification,
    purpose: r.purpose,
    validFrom: iso(r.validFrom),
    expiresAt: iso(r.expiresAt),
    status: r.status,
    version: r.version,
    supersedesId: r.supersedesId,
    invalidatedBy: r.invalidatedBy,
    invalidatedAt: iso(r.invalidatedAt),
    invalidationReason: r.invalidationReason,
    createdBy: r.createdBy,
    createdAt: iso(r.created_at || r.createdAt),
  };
}

/** Retrato para a auditoria: só campos de controle, nunca o valor da memória. */
function auditSnapshot(m) {
  const { id, memoryType, scope, status, version, classification, sourceType, sourceId, supersedesId, expiresAt, ownerUserId } = m;
  return { id, memoryType, scope, status, version, classification, sourceType, sourceId, supersedesId, expiresAt, ownerUserId };
}

module.exports = { toMemory, auditSnapshot };
