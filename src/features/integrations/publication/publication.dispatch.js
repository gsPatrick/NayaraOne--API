'use strict';

const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { loadPublicPropertyReadModel } = require('../../properties/publicReadModel');
const { createMinimizedDispatch } = require('../minimization');

/** Operações de publicação do imóvel por família: PORTAL e SITE (M9-D231 regra 5: o mapper do adapter consome o read model). */
const OPERATIONS = Object.freeze({
  PORTAL: ['publishListing', 'updateListing'],
  SITE: ['publishPage'],
});

const slugOf = (publicCode) => String(publicCode).toLowerCase();

/**
 * createPropertyPublicationDispatch — publica (ou atualiza) um imóvel num portal ou no site SOMENTE a partir do
 * PublicPropertyReadModel: carrega o registro público (409 INTEGRATION_PROPERTY_NOT_PUBLISHABLE se o imóvel não pode ser
 * publicado), passa pelo mapper da operação (M9-D219) e grava o envio com o payload já minimizado. Quem autorizou fica no envio
 * (created_by) e na auditoria do envio. `d`: connectionId, propertyId, operation, idempotencyKey, externalResourceId (updateListing), aggregateType e aggregateId (opcionais).
 */
async function createPropertyPublicationDispatch(ctx, d, transaction) {
  const connection = await IntegrationConnection.findOne({ where: { id: d.connectionId, companyId: ctx.companyId }, attributes: ['id', 'providerCode'], transaction });
  if (!connection) throw AppError.notFound('Integração não encontrada.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  const provider = await IntegrationProvider.findByPk(connection.providerCode, { attributes: ['code', 'domain'], transaction });
  const allowed = provider ? OPERATIONS[provider.domain] : null;
  if (!allowed || !allowed.includes(d.operation)) {
    throw AppError.badRequest('Esta operação não publica imóvel neste fornecedor.', 'INTEGRATION_OPERATION_UNSUPPORTED');
  }
  const readModel = await loadPublicPropertyReadModel(d.propertyId, ctx, transaction);
  const domainObject = { ...readModel, slug: slugOf(readModel.public_code), externalResourceId: d.externalResourceId };
  return createMinimizedDispatch(ctx, {
    connectionId: connection.id, operation: d.operation, idempotencyKey: d.idempotencyKey, domainObject,
    // M9-D232: o anúncio no portal é o agregado do envio (assim o vínculo acha o envio dele); sem ele, o imóvel.
    aggregateType: d.aggregateType || 'Property', aggregateId: d.aggregateId || d.propertyId,
  }, transaction);
}

/**
 * assertPropertyPublishable — o imóvel continua no PublicPropertyReadModel (M9-D239: conteúdo de rede social sobre um imóvel só sai se o
 * read model público o tem); senão 409 INTEGRATION_PROPERTY_NOT_PUBLISHABLE. Só lê: nada é enviado nem gravado.
 */
async function assertPropertyPublishable(ctx, propertyId, transaction) {
  await loadPublicPropertyReadModel(propertyId, ctx, transaction);
}

/**
 * loadPublicationReadModel — o registro público do imóvel para quem precisa conferir o conteúdo ANTES de criar o envio (M9-D232: o anúncio recusa internamente o que falta
 * ao portal). Este módulo continua sendo o único que lê o PublicPropertyReadModel para publicar (409 INTEGRATION_PROPERTY_NOT_PUBLISHABLE se o imóvel não pode sair).
 */
const loadPublicationReadModel = (ctx, propertyId, transaction) => loadPublicPropertyReadModel(propertyId, ctx, transaction);

module.exports = { createPropertyPublicationDispatch, assertPropertyPublishable, loadPublicationReadModel, OPERATIONS };
