'use strict';

const crypto = require('node:crypto');
const { Task, Notification } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { createOnceByActionKey } = require('../../../utils/createOnceByActionKey');
const { getSetting } = require('../../settings/settings.service');
const { activeUserIdsWithRole } = require('../../core-governance/governance.users');
const { recordError } = require('../errors');
const { readAlertParams } = require('../health/alerts/alerts.params');
const { LISTING_AGGREGATE } = require('./portal.constants');

const CODE = 'INTEGRATION_PORTAL_UNPUBLISH_EXHAUSTED';

/**
 * Remoção esgotada (M9-D233 3.1): o anúncio de imóvel indisponível segue no ar depois de todos os reenvios. Uma única vez por vínculo: tarefa URGENTE ao responsável (o papel das tarefas
 * manuais da contingência), erro de integração HIGH aberto e aviso IN_APP aos papéis de `integration.alert.notify_roles`.
 */
async function escalateExhausted(ctx, listing, transaction, { attempts, now }) {
  const texto = `O anúncio do imóvel no portal continua no ar depois de ${attempts} reenvios do pedido de remoção. Retirar o anúncio direto no painel do portal e conferir o status no sistema (vínculo ${listing.id}).`;
  await recordError(ctx, {
    providerCode: String(listing.providerCode || 'portal'), connectionId: listing.connectionId, source: 'SYNC', sourceRefId: listing.id, operation: 'unpublishListing', errorClass: 'UNKNOWN', errorCode: CODE, severity: 'HIGH',
    message: 'Anúncio de imóvel indisponível continua no ar: a remoção no portal esgotou as tentativas.', payload: { listingId: listing.id, attempts }, allowlist: ['listingId', 'attempts'],
  }, transaction);
  const papel = await getSetting('integration.contingency.manual_task_assignee_role', ctx, transaction, 'ADMIN');
  const donos = (await activeUserIdsWithRole(String(papel), { companyId: ctx.companyId }, transaction)).sort();
  await createOnceByActionKey(Task, {
    groupId: ctx.groupId, companyId: ctx.companyId, assignedToUserId: donos[0] || null, title: 'Anúncio de imóvel indisponível no ar: retirar do portal', description: texto,
    relatedEntityType: LISTING_AGGREGATE, relatedEntityId: listing.id, dueAt: new Date(now.getTime() + 4 * 3600000), status: 'OPEN', priority: 'URGENT',
    actionKey: crypto.createHash('sha256').update(`${CODE}:${listing.id}`).digest('hex'),
  }, { transaction });
  const { notifyRoles } = await readAlertParams(ctx, transaction);
  const destinatarios = new Set();
  for (const role of notifyRoles) (await activeUserIdsWithRole(role, { companyId: ctx.companyId }, transaction)).forEach((id) => destinatarios.add(id)); // eslint-disable-line no-await-in-loop
  if (destinatarios.size) {
    await Notification.bulkCreate([...destinatarios].map((userId) => ({
      groupId: ctx.groupId, companyId: ctx.companyId, userId, channel: 'IN_APP', title: '[ALERTA ALTO] Anúncio de imóvel indisponível continua no ar', body: texto,
    })), { transaction });
  }
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action: 'integration.portal_listing.unpublish_exhausted', entityType: 'PortalListing', entityId: listing.id,
    beforeJson: { unpublishExhaustedAt: null }, afterJson: { unpublishExhaustedAt: now.toISOString(), attempts }, reason: 'A remoção do anúncio esgotou as tentativas: tarefa urgente e alerta HIGH abertos.',
  }, transaction);
}

module.exports = { escalateExhausted, CODE };
