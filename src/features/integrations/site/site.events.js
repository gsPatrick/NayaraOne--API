'use strict';

const { SitePage } = require('../../../models');
const { registerDomainHandler } = require('../webhooks/worker/worker.handlers');
const { applyExternalPageStatus } = require('./site.apply');

/**
 * Tratador do domínio SITE do worker da caixa de entrada (M9-D212 + M9-D259): o webhook assinado do site vira o evento interno normalizado e é aplicado à página pelo `pageKey`, com a mesma regra
 * de ordem da consulta de status. O worker já descartou o que está fora de ordem DENTRO da mesma operação do site (o recurso do evento é o identificador da operação). Página desconhecida: o
 * evento fica no histórico sem aplicar (não é uma página nossa).
 */
async function onSiteWebhook(ctx, row, ev, transaction) {
  const pageKey = ev.data && ev.data.pageKey;
  if (!pageKey || !ev.internalStatus) return { applied: false };
  const page = await SitePage.findOne({ where: { companyId: ctx.companyId, connectionId: row.connectionId, pageKey }, transaction, lock: transaction.LOCK.UPDATE });
  if (!page) return { applied: false };
  const r = await applyExternalPageStatus(ctx, page, { status: ev.internalStatus, source: 'WEBHOOK_SIGNED', reason: ev.private && ev.private.reason }, transaction);
  return { applied: r.applied };
}

let installed = false;
function installSiteEvents() {
  if (installed) return;
  installed = true;
  registerDomainHandler('SITE', onSiteWebhook);
}

module.exports = { installSiteEvents, onSiteWebhook };
