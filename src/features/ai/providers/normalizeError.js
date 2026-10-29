'use strict';

const { AiProviderError } = require('./providers.errors');
const { classifyHttpError } = require('../../integrations');

const TIMEOUT_CODES = new Set(['TIMEOUT', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
const CLASS_TO_KIND = Object.freeze({ RATE_LIMIT: 'RATE_LIMIT', AUTH: 'AUTH', VALIDATION: 'VALIDATION', TRANSIENT: 'UNAVAILABLE', UNKNOWN: 'UNKNOWN' });

/**
 * Converte qualquer falha de fornecedor (erro de rede, resposta HTTP de erro, circuito aberto) em AiProviderError. Só o
 * status, o código e o tempo de espera passam adiante; o texto do fornecedor é descartado. `classify` é o `classifyError` do
 * adapter (cada fornecedor conhece os seus códigos); sem ele vale a classificação HTTP padrão das integrações.
 */
function normalizeProviderError(errOrResponse, { providerCode, classify = classifyHttpError } = {}) {
  if (errOrResponse instanceof AiProviderError) return errOrResponse;
  const e = errOrResponse || {};
  const code = String(e.code || '').toUpperCase();
  const upstreamStatus = Number(e.status ?? e.statusCode) || undefined;
  if (code === 'CIRCUIT_OPEN' || code === 'INTEGRATION_CIRCUIT_OPEN') return new AiProviderError('UNAVAILABLE', { providerCode, upstreamCode: 'CIRCUIT_OPEN' });
  if (TIMEOUT_CODES.has(code) || e.name === 'AbortError') return new AiProviderError('TIMEOUT', { providerCode, upstreamCode: 'TIMEOUT' });
  const c = classify(e) || { class: 'UNKNOWN' };
  const kind = CLASS_TO_KIND[c.class] || 'UNKNOWN';
  return new AiProviderError(kind, { providerCode, upstreamStatus, upstreamCode: c.code, retryAfterMs: c.retryAfterMs });
}

module.exports = { normalizeProviderError };
