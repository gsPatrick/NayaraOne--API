'use strict';

const AppError = require('../../../utils/AppError');
const { DOMAINS, ENVIRONMENTS, STATUSES: CONNECTION_STATUSES } = require('../registry/registry.constants');
const { SOURCES, STATUSES: ERROR_STATUSES } = require('../errors/errors.constants');

/** Validação dos parâmetros de consulta das APIs administrativas de leitura (M9-D249 3.2): qualquer valor fora da lista é 422 VALIDATION_ERROR. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEALTH_WINDOWS = Object.freeze(['5m', '1h', '1d', '30d']);
const DEFAULT_HEALTH_WINDOW = '1h';
const ERRORS_PAGE = Object.freeze({ min: 1, max: 200, padrao: 50 });

const invalid = (campo) => AppError.unprocessable('Parâmetro de consulta inválido.', 'VALIDATION_ERROR', { campo });

/** Texto opcional de um filtro: ausente ou vazio vale "sem filtro"; lista repetida (?a=1&a=2) é inválida. */
function optional(query, campo, permitidos) {
  const v = query[campo];
  if (v === undefined || v === '') return null;
  if (typeof v !== 'string' || (permitidos && !permitidos.includes(v))) throw invalid(campo);
  return v;
}

function parseListQuery(query = {}) {
  return {
    environment: optional(query, 'environment', ENVIRONMENTS),
    domain: optional(query, 'domain', DOMAINS),
    status: optional(query, 'status', CONNECTION_STATUSES),
  };
}

function parseHealthQuery(query = {}) {
  return {
    window: optional(query, 'window', HEALTH_WINDOWS) || DEFAULT_HEALTH_WINDOW,
    environment: optional(query, 'environment', ENVIRONMENTS),
  };
}

const encodeCursor = (createdAt, id) => Buffer.from(JSON.stringify({ t: new Date(createdAt).toISOString(), i: id }), 'utf8').toString('base64url');

function decodeCursor(texto) {
  try {
    const o = JSON.parse(Buffer.from(texto, 'base64url').toString('utf8'));
    if (!o || typeof o.t !== 'string' || Number.isNaN(Date.parse(o.t)) || typeof o.i !== 'string' || !UUID_RE.test(o.i)) throw new Error('cursor');
    return { createdAt: new Date(o.t), id: o.i };
  } catch {
    throw invalid('cursor');
  }
}

function parseErrorsQuery(query = {}) {
  const limitTexto = query.limit;
  let limit = ERRORS_PAGE.padrao;
  if (limitTexto !== undefined && limitTexto !== '') {
    if (typeof limitTexto !== 'string' || !/^\d{1,4}$/.test(limitTexto)) throw invalid('limit');
    limit = Number(limitTexto);
    if (limit < ERRORS_PAGE.min || limit > ERRORS_PAGE.max) throw invalid('limit');
  }
  const cursor = optional(query, 'cursor');
  const connectionId = optional(query, 'connectionId');
  if (connectionId && !UUID_RE.test(connectionId)) throw invalid('connectionId');
  return {
    status: optional(query, 'status', ERROR_STATUSES),
    source: optional(query, 'source', SOURCES),
    provider: optional(query, 'provider') || optional(query, 'providerCode'),
    connectionId,
    limit,
    cursor: cursor ? decodeCursor(cursor) : null,
  };
}

function parseUuid(valor, campo) {
  if (typeof valor !== 'string' || !UUID_RE.test(valor)) throw invalid(campo);
  return valor;
}

module.exports = { parseListQuery, parseHealthQuery, parseErrorsQuery, parseUuid, encodeCursor, HEALTH_WINDOWS, ERRORS_PAGE };
