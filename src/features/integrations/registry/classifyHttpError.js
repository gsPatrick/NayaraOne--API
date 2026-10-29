'use strict';

/**
 * Classificação padrão de erro HTTP/rede para o `classifyError` dos adapters que não têm tabela própria de códigos do
 * fornecedor: 429 -> RATE_LIMIT (com retryAfterMs), 401/403 -> AUTH, 400/422 -> VALIDATION, 5xx/408/rede/tempo -> TRANSIENT,
 * o resto -> UNKNOWN. Aceita um erro (status/code) ou uma resposta (status).
 */
function classifyHttpError(errOrResponse) {
  const e = errOrResponse || {};
  const status = Number(e.status ?? e.statusCode ?? e.details?.status ?? e.response?.status);
  const code = String(e.code || '').toUpperCase();
  const retry = e.retryAfterMs ?? (e.headers && typeof e.headers.get === 'function' && e.headers.get('retry-after') ? Number(e.headers.get('retry-after')) * 1000 : undefined);
  if (status === 429) return { class: 'RATE_LIMIT', code: 'HTTP_429', ...(Number.isFinite(retry) ? { retryAfterMs: retry } : {}) };
  if (status === 401 || status === 403) return { class: 'AUTH', code: `HTTP_${status}` };
  if (status === 400 || status === 422) return { class: 'VALIDATION', code: `HTTP_${status}` };
  if (status === 408 || (status >= 500 && status <= 599)) return { class: 'TRANSIENT', code: `HTTP_${status}` };
  if (['TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) || e.name === 'AbortError') return { class: 'TRANSIENT', code: code || 'NETWORK' };
  return { class: 'UNKNOWN', code: code || 'UNKNOWN' };
}

module.exports = { classifyHttpError };
