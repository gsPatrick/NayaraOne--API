'use strict';

const AppError = require('../../../utils/AppError');
const { IntegrationError } = require('../../../models');
const { SOURCES, STATUSES } = require('./errors.constants');
const { readErrorParams } = require('./errors.params');
const { serializeError } = require('./errors.serialize');

const LIMITE_PADRAO = 100;
const LIMITE_MAXIMO = 500;

/** Lista os erros da empresa (RLS isola as demais). `retentionDays` mostra quanto tempo o erro fica guardado. */
async function listErrors(ctx, query = {}, transaction) {
  const where = { companyId: ctx.companyId };
  if (query.status) {
    if (!STATUSES.includes(query.status)) throw AppError.badRequest(`O filtro "status" deve ser um de: ${STATUSES.join(', ')}.`, 'INTEGRATION_ERROR_INVALID');
    where.status = query.status;
  }
  if (query.source) {
    if (!SOURCES.includes(query.source)) throw AppError.badRequest(`O filtro "source" deve ser um de: ${SOURCES.join(', ')}.`, 'INTEGRATION_ERROR_INVALID');
    where.source = query.source;
  }
  if (query.providerCode) where.providerCode = String(query.providerCode);
  if (query.connectionId) where.connectionId = String(query.connectionId);
  const pedido = Number(query.limit);
  const limit = Number.isFinite(pedido) && pedido >= 1 ? Math.min(Math.floor(pedido), LIMITE_MAXIMO) : LIMITE_PADRAO;
  const [rows, params] = await Promise.all([
    IntegrationError.findAll({ where, order: [['created_at', 'DESC']], limit, transaction }),
    readErrorParams(ctx, transaction),
  ]);
  return { items: rows.map(serializeError), retentionDays: params.retentionDays };
}

module.exports = { listErrors };
