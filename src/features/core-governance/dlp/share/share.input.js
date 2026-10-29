'use strict';

const { getResource } = require('./share.catalog');
const errors = require('./share.errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HOURS = 8760;

/** Valida o corpo de POST /dlp/share-links (M9-D823 §3 item 1): recurso do catálogo, id, destinatário e, se informado, o prazo em horas inteiras. */
function parseShareBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw errors.requestInvalid('Corpo do link inválido.');
  const resource = typeof body.resourceType === 'string' ? getResource(body.resourceType) : null;
  if (!resource) throw errors.resourceInvalid();
  if (typeof body.resourceId !== 'string' || !UUID.test(body.resourceId)) throw errors.requestInvalid('Informe o identificador do recurso.', { field: 'resourceId' });
  const recipientLabel = typeof body.recipientLabel === 'string' ? body.recipientLabel.trim() : '';
  if (!recipientLabel || recipientLabel.length > 200) throw errors.requestInvalid('Informe o destinatário do link (até 200 caracteres).', { field: 'recipientLabel' });
  let expiresInHours = null;
  if (body.expiresInHours !== undefined && body.expiresInHours !== null) {
    if (!Number.isInteger(body.expiresInHours) || body.expiresInHours < 1 || body.expiresInHours > MAX_HOURS) throw errors.requestInvalid(`O prazo deve ser um número inteiro de horas entre 1 e ${MAX_HOURS}.`, { field: 'expiresInHours' });
    expiresInHours = body.expiresInHours;
  }
  return {
    resource, resourceId: body.resourceId.toLowerCase(), recipientLabel, expiresInHours, purpose: typeof body.purpose === 'string' ? body.purpose : null,
    justification: typeof body.justification === 'string' ? body.justification : null,
  };
}

/** O que o pedido pediu, em forma estável, para conferir uma repetição da mesma Idempotency-Key. */
const fingerprint = (parsed) => ({ resourceType: parsed.resource.code, resourceId: parsed.resourceId, recipientLabel: parsed.recipientLabel, expiresInHours: parsed.expiresInHours });

module.exports = { parseShareBody, fingerprint };
