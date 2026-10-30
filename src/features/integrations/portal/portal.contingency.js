'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { PortalListing, IntegrationDispatch, Task } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { createOnceByActionKey } = require('../../../utils/createOnceByActionKey');
const { resolveDomainAssignee } = require('../contingency/contingency.assignee');
const { LISTING_AGGREGATE } = require('./portal.constants');
const { publishStatusChanged } = require('./portal.status');

const QUEUED = ['PENDING', 'RETRY_WAIT'];
const PUBLISH_OPS = ['publishListing', 'updateListing'];
const { MENSAGEM } = require('./portal.contingency.message');
const ACTION = 'INTEGRATION_PORTAL_PENDING_SYNC';
const PAPEL_PADRAO = 'Gerente de Marketing';

/** O envio de publicação ou atualização mais recente do anúncio está na fila (esperando o portal)? */
async function hasQueuedPublish(ctx, listingId, transaction) {
  const envio = await IntegrationDispatch.findOne({
    where: { companyId: ctx.companyId, aggregateType: LISTING_AGGREGATE, aggregateId: listingId, operation: PUBLISH_OPS }, order: [['created_at', 'DESC']], transaction,
  });
  return Boolean(envio) && QUEUED.includes(envio.status);
}

/** Marca o anúncio como PENDING_SYNC com o motivo (idempotente). Publica `properties.portal_listing.status_changed` quando o estado muda. */
async function markPendingSync(ctx, listing, now, transaction) {
  const antes = listing.status;
  await listing.update({ status: 'PENDING_SYNC', pendingSyncSince: listing.pendingSyncSince || now, lastError: MENSAGEM }, { transaction });
  if (antes !== 'PENDING_SYNC') {
    await publishStatusChanged(ctx, listing, { from: antes, to: 'PENDING_SYNC' }, `pending-${listing.id}-${now.getTime()}`, transaction);
    await registrarAuditoria({
      groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action: 'integration.portal_listing.pending_sync', entityType: LISTING_AGGREGATE, entityId: listing.id,
      beforeJson: { status: antes }, afterJson: { status: 'PENDING_SYNC', pendingSyncSince: listing.pendingSyncSince }, reason: 'Portal fora: o anúncio fica PENDING_SYNC e o imóvel segue publicado internamente.',
    }, transaction);
  }
}

/** Tarefa ao responsável de marketing (uma única vez por anúncio), passado o prazo da fila do modo (24 h). */
async function openMarketingTask(ctx, listing, hours, now, transaction) {
  const dono = await resolveDomainAssignee(ctx, 'integration.portal.manual_task_assignee_role', PAPEL_PADRAO, transaction);
  await createOnceByActionKey(Task, {
    groupId: ctx.groupId, companyId: ctx.companyId, assignedToUserId: dono, title: 'Anúncio do imóvel pendente no portal há mais de ' + hours + ' h',
    description: `O anúncio do imóvel não sincronizou com o portal depois de ${hours} h de indisponibilidade (vínculo ${listing.id}). O imóvel segue publicado internamente: confira o portal ou publique manualmente.`,
    relatedEntityType: LISTING_AGGREGATE, relatedEntityId: listing.id, dueAt: new Date(now.getTime() + 4 * 3600000), status: 'OPEN', priority: 'HIGH',
    actionKey: crypto.createHash('sha256').update(`${ACTION}:${listing.id}`).digest('hex'),
  }, { transaction });
  await listing.update({ pendingTaskAt: now }, { transaction });
}

/**
 * Passo da contingência do portal por connection (M9-D227 3.2): o anúncio cujo envio espera o portal (PUBLISHING com envio na fila) vai a PENDING_SYNC com o motivo (o imóvel
 * segue publicado no ERP); o anúncio PENDING_SYNC há mais de `policy.queueMaxAgeH` horas ganha UMA tarefa ao responsável de marketing. A despublicação pendente continua
 * UNPUBLISHING (M9-D233) e o portal fora de uma connection nunca mexe nos anúncios das outras. Devolve { marked, tasks }.
 */
async function portalStep(ctx, { connection, policy, now }, transaction) {
  const resumo = { marked: 0, tasks: 0 };
  const publicando = await PortalListing.findAll({ where: { companyId: ctx.companyId, connectionId: connection.id, supersededAt: null, status: 'PUBLISHING' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const listing of publicando) {
    if (await hasQueuedPublish(ctx, listing.id, transaction)) { await markPendingSync(ctx, listing, now, transaction); resumo.marked += 1; }
  }
  if (policy.queueMaxAgeH !== null && policy.queueMaxAgeH !== undefined) {
    const corte = new Date(now.getTime() - policy.queueMaxAgeH * 3600000);
    const velhos = await PortalListing.findAll({
      where: { companyId: ctx.companyId, connectionId: connection.id, supersededAt: null, status: 'PENDING_SYNC', pendingTaskAt: null, pendingSyncSince: { [Op.lte]: corte } }, transaction, lock: transaction.LOCK.UPDATE,
    });
    for (const listing of velhos) { await openMarketingTask(ctx, listing, policy.queueMaxAgeH, now, transaction); resumo.tasks += 1; }
  }
  return resumo;
}

/** Item vencido da fila de um anúncio (publicar ou atualizar): a tarefa é do anúncio (portalStep); o item não vira a tarefa genérica de envio. A remoção pendente segue a regra da M9-D233. */
async function handleAgedPortal(ctx, item, _policy, _now, transaction) {
  const envio = await IntegrationDispatch.findOne({ where: { id: item.id, companyId: ctx.companyId }, transaction });
  return envio && envio.aggregateType === LISTING_AGGREGATE && PUBLISH_OPS.includes(envio.operation) ? { handled: true } : null;
}

module.exports = { portalStep, handleAgedPortal, markPendingSync, hasQueuedPublish, MENSAGEM, PAPEL_PADRAO };
