'use strict';

const crypto = require('node:crypto');
const { ACTIONS, CLASSES } = require('./dlp.constants');
const { requestInvalid } = require('./dlp.errors');
const { isLight } = require('./dlp.guard');

/** Tipos de pedido (`kind`) que cada ação aceita; sem informar, vale a própria ação (M9-D821 §3.2, decisão K10). */
const KINDS_BY_ACTION = Object.freeze({ EXPORT: ['EXPORT', 'DOWNLOAD'], PRINT: ['PRINT', 'DOWNLOAD'], SHARE: ['SHARE'] });
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : null);

/** Recursos pedidos para o resolvedor de classificação: um por id, a consulta inteira como um recurso, ou um recurso sem identificação. */
function resourcesOf(raw, resourceType) {
  if (Array.isArray(raw.resourceIds) && raw.resourceIds.length) return raw.resourceIds.map((id) => ({ id, type: resourceType }));
  if (raw.query && typeof raw.query === 'object') return [{ query: raw.query, type: resourceType }];
  return [{ type: resourceType }];
}

/**
 * `minClassification` (M9-D825): classe mínima que o chamador já conhece (a do campo no registro); a classe decidida é a MAIS ALTA entre ela e a do resolvedor.
 * Valida e normaliza o pedido do guard (400 GOV_DLP_REQUEST_INVALID antes de gravar qualquer coisa). Exportação exige `estimatedRows` inteiro; compartilhar e
 * imprimir assumem 0 quando não informado.
 */
function normalize(raw, tenant) {
  if (!raw || typeof raw !== 'object') throw requestInvalid('Pedido de DLP inválido.');
  const action = String(raw.action || '').toUpperCase();
  if (!ACTIONS.includes(action)) throw requestInvalid('Ação de DLP inválida.', { field: 'action' });
  const resourceType = text(raw.resourceType, 80);
  if (!resourceType) throw requestInvalid('Informe o tipo de recurso.', { field: 'resourceType' });
  const light = isLight(action);
  let kind = null;
  if (!light) {
    kind = raw.kind === undefined || raw.kind === null ? action : String(raw.kind).toUpperCase();
    if (!KINDS_BY_ACTION[action].includes(kind)) throw requestInvalid('Tipo de pedido inválido para esta ação.', { field: 'kind' });
  }
  let estimatedRows = raw.estimatedRows;
  if (estimatedRows === undefined || estimatedRows === null) {
    if (action === 'EXPORT') throw requestInvalid('Informe a quantidade estimada de linhas.', { field: 'estimatedRows' });
    estimatedRows = 0;
  }
  if (!Number.isInteger(estimatedRows) || estimatedRows < 0) throw requestInvalid('A quantidade estimada de linhas deve ser um número inteiro maior ou igual a zero.', { field: 'estimatedRows' });
  const actorUserId = raw.actorUserId || (tenant && tenant.userId) || null;
  const body = {
    action, kind, resourceType, resourceIds: Array.isArray(raw.resourceIds) ? raw.resourceIds : null, query: raw.query || null, purpose: text(raw.purpose, 40),
    justification: typeof raw.justification === 'string' ? raw.justification : null, estimatedRows, watermarkRequested: raw.watermarkRequested === true,
  };
  return {
    ...body, actorUserId, minClassification: CLASSES.includes(raw.minClassification) ? raw.minClassification : null, ip: text(raw.ip, 64), mfaOk: raw.mfaOk === true, aiAllowed: raw.aiAllowed, originPermission: text(raw.originPermission, 100),
    permissions: Array.isArray(raw.permissions) ? raw.permissions : null, maxRowsCap: Number.isInteger(raw.maxRowsCap) && raw.maxRowsCap > 0 ? raw.maxRowsCap : null, idempotencyKey: text(raw.idempotencyKey, 128) || null, correlationId: text(raw.correlationId, 100),
    resources: resourcesOf(raw, resourceType), requestHash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
}

module.exports = { normalize, KINDS_BY_ACTION };
