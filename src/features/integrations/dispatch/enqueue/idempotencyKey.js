'use strict';

const crypto = require('crypto');

/**
 * Chave estável derivada (M9-D214 3.1 item 5): sha256(company_id|provider_code|operation|aggregate_type|aggregate_id|payload_hash).
 * Determinística: a mesma intenção gera a mesma chave em qualquer nó e depois de reiniciar; conteúdo diferente gera chave diferente.
 */
function deriveIdempotencyKey({ companyId, providerCode, operation, aggregateType, aggregateId, payloadHash }) {
  const partes = [companyId, providerCode, operation, aggregateType || '', aggregateId || '', payloadHash];
  return crypto.createHash('sha256').update(partes.join('|'), 'utf8').digest('hex');
}

module.exports = { deriveIdempotencyKey };
