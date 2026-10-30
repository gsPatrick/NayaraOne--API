'use strict';

const { sequelize, IntegrationConnection, IntegrationProvider } = require('../../../models');
const AppError = require('../../../utils/AppError');
const logger = require('../../../utils/logger');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const adapterRegistry = require('../registry/adapterRegistry');
const { hashPayload } = require('../dispatch/canonicalJson');
const { createPropertyPublicationDispatch, loadPublicationReadModel } = require('../publication');
const { findActive, createListing, listActive } = require('./portal.listing.store');
const { minimizedListing } = require('./portal.minimize');
const { ensurePortalAdaptersRegistered } = require('./portal.boot');
const { REQUIRED_MISSING_CODE, REQUIRED_MISSING_MESSAGE } = require('./portal.constants');

const notFound = () => AppError.notFound('Nenhuma integração ativa para este recurso: configure em Integrações.', 'INTEGRATION_CONNECTION_NOT_FOUND');

/** Os portais contratados (connection ACTIVE de fornecedor da família PORTAL) da empresa, opcionalmente só os pedidos. */
async function activePortals(ctx, connectionIds, transaction) {
  const providers = await IntegrationProvider.findAll({ where: { domain: 'PORTAL' }, attributes: ['code'], transaction });
  const where = { companyId: ctx.companyId, status: 'ACTIVE', providerCode: providers.map((p) => p.code) };
  if (Array.isArray(connectionIds) && connectionIds.length) where.id = connectionIds;
  const lista = await IntegrationConnection.findAll({ where, order: [['created_at', 'ASC']], transaction });
  if (!lista.length || (Array.isArray(connectionIds) && connectionIds.length && lista.length !== new Set(connectionIds).size)) throw notFound();
  return lista;
}

const audit = (ctx, listing, action, antes, depois, reason, transaction) => registrarAuditoria({
  groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action, entityType: 'PortalListing', entityId: listing.id, beforeJson: antes, afterJson: depois, reason,
}, transaction);

const toItem = (con, listing, extra = {}) => ({
  connectionId: con.id, providerCode: con.providerCode, listingId: listing.id, status: listing.status, externalListingId: listing.externalListingId || null, rejectionReason: listing.rejectionReason || null,
  mappingVersion: listing.mappingVersion, fieldsDropped: listing.fieldsDropped || [], dispatchId: null, noop: false, operation: null, ...extra,
});

/** Publica (ou atualiza) o imóvel em UM portal. Recusa internamente o que falta (sem chamar o portal), compara o hash e cria o envio só quando o conteúdo mudou. */
async function publishOne(ctx, con, propertyId, readModel, transaction) {
  const adapter = adapterRegistry.instantiate(con.providerCode);
  if (!adapter) throw notFound();
  const mapped = adapter.mapListing(await minimizedListing(readModel, ctx, transaction));
  const version = adapter.mappingVersion();
  let listing = await findActive(ctx, propertyId, con.id, transaction);
  if (!listing) listing = await createListing(ctx, { propertyId, connectionId: con.id, mappingVersion: version }, transaction);
  const antes = { status: listing.status, payloadHash: listing.payloadHash };

  if (mapped.missing.length) {
    const motivo = `MISSING_REQUIRED:${mapped.missing[0]}`;
    await listing.update({ status: 'REJECTED', rejectionReason: motivo, mappingVersion: version, fieldsDropped: mapped.fieldsDropped, lastError: `${REQUIRED_MISSING_MESSAGE} Campos: ${mapped.missing.join(', ')}.` }, { transaction });
    await audit(ctx, listing, 'integration.portal_listing.rejected_internally', antes, { status: 'REJECTED', rejectionReason: motivo }, 'Anúncio recusado internamente: falta dado exigido pelo portal (o portal não foi chamado).', transaction);
    return toItem(con, listing, { code: REQUIRED_MISSING_CODE, message: REQUIRED_MISSING_MESSAGE, missing: mapped.missing });
  }
  const hash = hashPayload({ mappingVersion: version, payload: mapped.payload });
  if (listing.payloadHash === hash && ['PENDING_SYNC', 'PUBLISHING', 'PUBLISHED'].includes(listing.status)) return toItem(con, listing, { noop: true });

  const operation = listing.externalListingId && ['PUBLISHING', 'PUBLISHED', 'ERROR', 'REJECTED'].includes(listing.status) ? 'updateListing' : 'publishListing';
  const { dispatch } = await createPropertyPublicationDispatch(ctx, {
    connectionId: con.id, propertyId, operation, idempotencyKey: `portal:${operation}:${listing.id}:${hash.slice(0, 24)}`, externalResourceId: listing.externalListingId || undefined,
    aggregateType: 'PortalListing', aggregateId: listing.id,
  }, transaction);
  await listing.update({ status: 'PUBLISHING', payloadHash: hash, mappingVersion: version, fieldsDropped: mapped.fieldsDropped, rejectionReason: null, lastError: null }, { transaction });
  await audit(ctx, listing, 'integration.portal_listing.publish_requested', antes, { status: 'PUBLISHING', payloadHash: hash, operation }, `Anúncio enviado ao portal (${operation}).`, transaction);
  return toItem(con, listing, { dispatchId: dispatch.id, operation });
}

/**
 * publishToPortals — publica o imóvel em cada portal contratado (M9-D232 3.5): um envio independente por portal; a falha de um não cancela os demais e vira
 * `last_error` do vínculo dele. O conteúdo vem SÓ do PublicPropertyReadModel (409 INTEGRATION_PROPERTY_NOT_PUBLISHABLE se o imóvel não pode ser publicado).
 * Devolve { total, published, items }.
 */
async function publishToPortals(ctx, { propertyId, connectionIds } = {}, transaction) {
  ensurePortalAdaptersRegistered();
  const portais = await activePortals(ctx, connectionIds, transaction);
  const readModel = await loadPublicationReadModel(ctx, propertyId, transaction);
  const items = [];
  for (const con of portais) {
    try {
      // eslint-disable-next-line no-await-in-loop
      items.push(await sequelize.transaction({ transaction }, (savepoint) => publishOne(ctx, con, propertyId, readModel, savepoint)));
    } catch (err) {
      logger.warn({ connectionId: con.id, err: err.message, code: err.code }, 'Portal: a publicação deste portal falhou; os demais seguem.');
      items.push({ connectionId: con.id, providerCode: con.providerCode, status: 'ERROR', code: err.code || 'INTEGRATION_PORTAL_PUBLISH_FAILED', message: err.message, dispatchId: null, noop: false });
    }
  }
  return summarize(items);
}

const summarize = (items) => ({ total: items.length, published: items.filter((i) => i.status === 'PUBLISHED').length, items });

/** O estado do imóvel em cada portal contratado: N de M publicados. */
async function listPortalListings(ctx, propertyId, transaction) {
  const portais = await IntegrationConnection.findAll({ where: { companyId: ctx.companyId, status: 'ACTIVE', providerCode: (await IntegrationProvider.findAll({ where: { domain: 'PORTAL' }, attributes: ['code'], transaction })).map((p) => p.code) }, transaction });
  const vinculos = await listActive(ctx, propertyId, transaction);
  const items = portais.map((con) => {
    const l = vinculos.find((v) => v.connectionId === con.id);
    return l ? toItem(con, l) : { connectionId: con.id, providerCode: con.providerCode, listingId: null, status: null, externalListingId: null, rejectionReason: null, noop: false, dispatchId: null };
  });
  return summarize(items);
}

module.exports = { publishToPortals, listPortalListings, activePortals, summarize };
