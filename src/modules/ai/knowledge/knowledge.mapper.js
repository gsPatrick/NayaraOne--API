'use strict';

const iso = (d) => (d ? new Date(d).toISOString() : null);

function toEntry(model) {
  const k = model.get({ plain: true });
  return {
    id: k.id,
    factKey: k.factKey,
    version: k.version,
    status: k.status,
    subjectType: k.subjectType,
    subjectId: k.subjectId,
    title: k.title,
    value: k.factValueJson,
    bodyStructured: k.bodyStructured,
    origin: k.origin,
    classification: k.classification,
    validFrom: iso(k.validFrom),
    validUntil: iso(k.validUntil),
    isActive: k.isActive,
    contentHash: k.contentHash,
    ownerUserId: k.ownerUserId,
    sourceId: k.sourceId,
    createdBy: k.createdBy,
    createdAt: iso(k.createdAt),
    homologatedBy: k.homologatedBy,
    homologatedAt: iso(k.homologatedAt),
    revokedBy: k.revokedBy,
    revokedAt: iso(k.revokedAt),
    revokeReason: k.revokeReason,
    lockVersion: k.lockVersion,
  };
}

/** Trilha de auditoria: sem o conteúdo (só o hash), nunca texto de política. */
function auditSnapshot(e) {
  return {
    factKey: e.factKey, version: e.version, status: e.status, classification: e.classification, contentHash: e.contentHash,
    validFrom: e.validFrom, validUntil: e.validUntil, homologatedBy: e.homologatedBy, revokedBy: e.revokedBy, revokeReason: e.revokeReason,
  };
}

module.exports = { toEntry, auditSnapshot };
