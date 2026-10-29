'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');

/** Ações da auditoria do ciclo do arquivo (a do pedido é a do guard, governance.dlp.export). Nomes por extenso: o lineage (M9-D810) e a busca por eles apontam para este arquivo. */
const ACTIONS = Object.freeze({ generated: 'dlp.export.generated', failed: 'dlp.export.failed', downloaded: 'dlp.export.downloaded', expired: 'dlp.export.expired' });

/** Auditoria do ciclo do arquivo: gerado, falhou, baixado e expirado. */
function auditExport(job, action, { actorUserId = job.actorUserId, after = null, before = null, reason, ip = null, userAgent = null }, transaction) {
  return registrarAuditoria({
    groupId: job.groupId, companyId: job.companyId, actorUserId, action: ACTIONS[action], entityType: 'ExportJob', entityId: job.id,
    beforeJson: before, afterJson: after ? { ...after, ...(ip ? { ip } : {}), ...(userAgent ? { userAgent: String(userAgent).slice(0, 300) } : {}) } : null, reason,
  }, transaction);
}

module.exports = { auditExport, ACTIONS };
