'use strict';

const crypto = require('node:crypto');

/**
 * Corpo bruto de webhook e payload de provider NUNCA vão a log (M9-D246 3.1): só hash, tamanho e tipo de evento.
 * `describeForLog(corpo, tipo)` devolve o que pode ser logado no lugar do corpo.
 */
function describeForLog(rawBody, eventType = null) {
  const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody ?? ''));
  return {
    payload_hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    event_type: eventType ? String(eventType).slice(0, 80) : null,
  };
}

module.exports = { describeForLog };
