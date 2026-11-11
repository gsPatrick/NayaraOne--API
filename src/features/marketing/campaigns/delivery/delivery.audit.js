'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');

const ENTITY = 'marketing.campaign_step_delivery';

/**
 * Auditoria das passagens da entrega que não são o envio normal (esse já fica em marketing.message.sent): reconciliação do UNKNOWN, fila morta (tentativas ou
 * consultas esgotadas), cancelamento no fim da campanha e reprocessamento. Sempre com antes e depois; sem conteúdo da mensagem nem endereço.
 * `kind`: reconciled | failed | cancelled | reprocessed. `actorUserId` só no reprocessamento (ação humana).
 */
async function auditDelivery(tenant, kind, deliveryId, { before, after, reason, actorUserId = null }, transaction) {
  if (!deliveryId) return;
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: `marketing.campaign.delivery.${kind}`, entityType: ENTITY, entityId: deliveryId,
    beforeJson: before || null, afterJson: after || null, reason,
  }, transaction);
}

module.exports = { auditDelivery, ENTITY };
