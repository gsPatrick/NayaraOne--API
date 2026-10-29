'use strict';

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Ingestão para a API: sem group_id e sem dado do conteúdo (só estado, hash, contagens e quem pediu). */
function toIngestion(model) {
  const r = model.get({ plain: true });
  return {
    id: r.id, sourceKind: r.sourceKind, sourceRef: r.sourceRef, status: r.status, step: r.step, errorCode: r.errorCode, contentHash: r.contentHash,
    classification: r.classification, sourceVersion: r.sourceVersion, secretsRemoved: r.secretsRemoved, activeContentDiscarded: r.activeContentDiscarded,
    chunksCount: r.chunksCount, createdBy: r.createdBy, startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt),
  };
}

/** Campos de controle para a trilha de auditoria (nunca texto do documento). */
function auditSnapshot(i) {
  return { id: i.id, sourceKind: i.sourceKind, sourceId: i.sourceId, status: i.status, step: i.step, errorCode: i.errorCode, sourceVersion: i.sourceVersion, classification: i.classification };
}

module.exports = { toIngestion, auditSnapshot };
