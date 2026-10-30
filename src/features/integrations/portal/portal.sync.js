'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { PortalListing, IntegrationConnection } = require('../../../models');
const logger = require('../../../utils/logger');
const { runSyncCycle } = require('../sync');
const { tenantTx } = require('../dispatch/worker/tenantTx');
const adapterRegistry = require('../registry/adapterRegistry');
const { invoke } = require('../registry/adapterInvoke');
const { ensurePortalAdaptersRegistered } = require('./portal.boot');
const { readPortalParams } = require('./portal.params');
const { STREAM, SYNCABLE } = require('./portal.constants');
const { applyExternalListingStatus, lastPublishDispatch } = require('./portal.status');
const { reprocessPendingSync } = require('./portal.reprocess');

/** Lê o estado de UM anúncio no portal e aplica. Portal fora do ar não derruba nada: grava o erro no vínculo e segue. Devolve { changed } ou { skipped }. */
async function syncOne(ctx, listingId, transaction) {
  const listing = await PortalListing.findOne({ where: { id: listingId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!listing || listing.supersededAt || !SYNCABLE.includes(listing.status)) return { skipped: true };
  if (!listing.externalListingId) {
    const envio = await lastPublishDispatch(ctx, listing.id, transaction);
    if (!envio || !envio.externalResourceId) return { skipped: true }; // o envio ainda não saiu
    await listing.update({ externalListingId: envio.externalResourceId }, { transaction });
  }
  const connection = await IntegrationConnection.findByPk(listing.connectionId, { transaction });
  if (!connection || connection.status !== 'ACTIVE') return { skipped: true };
  const adapter = await adapterRegistry.resolve(connection, ctx, transaction);
  let bruta = null;
  let externo;
  try {
    const r = await invoke(adapter, 'getListingStatus', { externalResourceId: listing.externalListingId }, { tenant: ctx, transaction, onResponse: (x) => { bruta = x; } });
    externo = { status: r.status, rejectionReason: bruta && bruta.rejectionReason };
  } catch (err) {
    if (Number(err && (err.status ?? err.statusCode)) === 404) externo = { status: 'UNPUBLISHED' }; // o portal não conhece o anúncio
    else {
      await listing.update({ lastError: `Não foi possível consultar o portal: ${String(err.message || err.code).slice(0, 200)}` }, { transaction });
      return { changed: false, error: err.code || 'ERROR' };
    }
  }
  return applyExternalListingStatus(ctx, listing, externo, transaction);
}

function sourceFor({ ctx, connectionId, pageSize, totals }) {
  return {
    async fetchPage({ cursorValue }) {
      const ids = (await tenantTx(ctx, (transaction) => PortalListing.findAll({
        where: { companyId: ctx.companyId, connectionId, supersededAt: null, status: { [Op.in]: SYNCABLE }, ...(cursorValue ? { id: { [Op.gt]: cursorValue } } : {}) },
        attributes: ['id'], order: [['id', 'ASC']], limit: pageSize, transaction,
      }))).map((l) => l.id);
      // Fim da lista: o cursor volta ao começo junto com a última página (a varredura seguinte recomeça).
      if (!ids.length) return { items: [], nextCursor: cursorValue ? '' : null, done: true };
      return { items: ids, nextCursor: ids.length < pageSize ? '' : ids[ids.length - 1], done: ids.length < pageSize };
    },
    async applyItems(ids, { transaction }) {
      let mudaram = 0;
      for (const id of ids) {
        totals.checked += 1;
        // eslint-disable-next-line no-await-in-loop
        const r = await syncOne(ctx, id, transaction);
        if (r.changed) { mudaram += 1; totals.changed += 1; }
      }
      return mudaram;
    },
  };
}

/** Varre os anúncios de cada portal da empresa pelo fluxo `portal.listing_status` (cursor retomável e lease, M9-D208). Devolve { connections, checked, changed }. */
async function syncListingStatuses({ group, company, onlyConnectionId }) {
  ensurePortalAdaptersRegistered();
  const ctx = { groupId: group.id, companyId: company.id, userId: null };
  const { syncPageSize } = await tenantTx(ctx, (t) => readPortalParams(ctx, t));
  await reprocessPendingSync(ctx); // M9-D227: o anúncio PENDING_SYNC (portal que esteve fora) é reprocessado a cada intervalo até o portal aceitar
  const conexoes = (await tenantTx(ctx, (transaction) => PortalListing.findAll({
    where: { companyId: ctx.companyId, supersededAt: null, status: { [Op.in]: SYNCABLE } }, attributes: ['connectionId'], group: ['connection_id'], transaction,
  }))).map((l) => l.connectionId).filter((id) => !onlyConnectionId || id === onlyConnectionId);
  const totals = { connections: conexoes.length, checked: 0, changed: 0 };
  for (const connectionId of conexoes) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await runSyncCycle({ connectionId, stream: STREAM, cursorKind: 'TOKEN', workerId: `portal-sync-${crypto.randomUUID()}` }, ctx, sourceFor({ ctx, connectionId, pageSize: syncPageSize, totals }));
    } catch (err) {
      logger.warn({ connectionId, err: err.message, code: err.code }, 'Portais: a leitura de status não pôde rodar.');
    }
  }
  return totals;
}

module.exports = { syncListingStatuses, syncOne };
