'use strict';

/** O link como a API o mostra: nunca traz o hash nem o token (o token só vai na resposta da criação). ACTIVE com prazo vencido aparece como EXPIRED, mesmo antes do job. */
function shareView(link, now = new Date()) {
  const status = link.status === 'ACTIVE' && new Date(link.expiresAt) <= now ? 'EXPIRED' : link.status;
  return {
    id: link.id, resourceType: link.resourceType, resourceId: link.resourceId, recipientLabel: link.recipientLabel, classification: link.classification, status, expiresAt: link.expiresAt,
    createdBy: link.createdBy, createdAt: link.createdAt, revokedBy: link.revokedBy, revokedAt: link.revokedAt, exportJobId: link.exportJobId, watermark: link.watermark,
    accessCount: link.accessCount, lastAccessedAt: link.lastAccessedAt,
  };
}

module.exports = { shareView };
