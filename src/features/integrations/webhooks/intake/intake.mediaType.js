'use strict';

const { unsupportedMedia } = require('../webhooks.errors');

const FORM = 'application/x-www-form-urlencoded';

/** Tipo de conteúdo sem parâmetros (charset) e em minúsculas. */
const mediaTypeOf = (headers) => {
  const v = headers && headers['content-type'];
  return String(Array.isArray(v) ? v[0] : v || '').split(';')[0].trim().toLowerCase();
};

/**
 * Confere o tipo de conteúdo (M9-D213 3.2): os da empresa (padrão application/json e text/plain) mais os que o adapter do fornecedor declara
 * (o formulário só vale para quem o declara). Qualquer outro: 415 INTEGRATION_WEBHOOK_UNSUPPORTED_MEDIA.
 */
function assertMediaType(headers, accepted, declaredByAdapter = []) {
  const tipo = mediaTypeOf(headers);
  const permitidos = new Set([...accepted.filter((t) => t !== FORM), ...declaredByAdapter.map((t) => String(t).toLowerCase())]);
  if (!tipo || !permitidos.has(tipo)) throw unsupportedMedia();
  return tipo;
}

module.exports = { assertMediaType, mediaTypeOf, FORM };
