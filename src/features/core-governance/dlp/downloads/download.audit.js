'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');

/** Auditoria `files.downloaded` (M9-D920 §3.3): quem, quando (o log carrega), de onde (IP e agente), o que (ids, classe, marca) e o hash do original, que a marca nunca altera. */
function auditDownloaded({ tenant, actorUserId, job, classification, items, delivered, watermark, ip, userAgent }, transaction) {
  const single = items.length === 1;
  return registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'files.downloaded', entityType: single ? 'File' : 'ExportJob', entityId: single ? items[0].id : (job ? job.id : null), beforeJson: null,
    afterJson: {
      exportJobId: job ? job.id : null, classification, count: items.length, fileIds: items.map((item) => item.id), originalSha256: items.map((item) => item.sha256),
      deliveredSha256: delivered.sha256, watermark, ...(ip ? { ip } : {}), ...(userAgent ? { userAgent: String(userAgent).slice(0, 300) } : {}),
    },
    reason: single ? `Arquivo "${items[0].fileName}" baixado (classe ${classification}${watermark ? ', com marca d\'água' : ''}).` : `${items.length} arquivos baixados em lote (classe ${classification}${watermark ? ', com marca d\'água' : ''}).`,
  }, transaction);
}

module.exports = { auditDownloaded };
