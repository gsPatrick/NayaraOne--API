'use strict';

const { requestInvalid } = require('../dlp.errors');
const { govError } = require('../../governance.errors');
const { getPrintable } = require('./print.catalog');
const { assertUuid, yes } = require('../downloads/download.input');

/** Corpo de POST /dlp/print-events: { resourceType, resourceId, purpose, justification, watermark? }. Tipo fora do catálogo de imprimíveis é 400 GOV_PRINT_RESOURCE_INVALID. */
function parsePrintBody(body) {
  if (!body || typeof body !== 'object') throw requestInvalid('Pedido de impressão inválido.');
  const resource = typeof body.resourceType === 'string' ? getPrintable(body.resourceType) : null;
  if (!resource) throw govError(400, 'GOV_PRINT_RESOURCE_INVALID', 'Este tipo de documento não pode ser impresso por aqui.', { field: 'resourceType' });
  const resourceId = assertUuid(body.resourceId);
  return {
    resource, resourceId, purpose: typeof body.purpose === 'string' ? body.purpose : null, justification: typeof body.justification === 'string' ? body.justification : null, watermark: yes(body.watermark),
  };
}

module.exports = { parsePrintBody };
