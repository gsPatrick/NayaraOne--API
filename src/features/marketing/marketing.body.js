'use strict';

const { mktError } = require('./marketing.errors');

/**
 * M9-D435 regra comum (d) — corpo só com os campos que a rota conhece: qualquer outro é recusado com 400 MKT_VALIDATION e a lista dos desconhecidos em details.unknown.
 * Corpo que não é objeto fica para o validador da própria rota (cada uma tem a sua mensagem).
 */
function assertKnownBodyFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw mktError(400, 'MKT_VALIDATION', `Dados inválidos: campo(s) desconhecido(s): ${unknown.join(', ')}.`, { unknown });
}

module.exports = { assertKnownBodyFields };
