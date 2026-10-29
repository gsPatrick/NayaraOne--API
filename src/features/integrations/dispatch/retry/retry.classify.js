'use strict';

const { parseRetryAfterMs, headerOf } = require('./retry.delay');

const PRE_SEND = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);
const TIMEOUT = new Set(['TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ABORT_ERR', 'ERR_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const RESET = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);
const SERVER_ERRORS = new Set([500, 502, 503, 504]);
const CLASSES = ['TRANSIENT', 'RATE_LIMIT', 'AUTH', 'VALIDATION', 'UNKNOWN'];
const CREDENTIAL_RE = /(token|credencial|credential|unauthori[sz]ed|expired|expirad|invalid[_ -]?(api[_ -]?)?key|api[_ -]?key|bearer|forbidden[_ -]?credential|auth)/i;
const GENERIC_CODE_RE = /^(HTTP_\d{3}|NETWORK|UNKNOWN|UNCLASSIFIED|TIMEOUT)$/;

const isGeneric = (c) => GENERIC_CODE_RE.test(c) || PRE_SEND.has(c) || TIMEOUT.has(c) || RESET.has(c);

const statusOf = (e) => {
  const s = Number(e && (e.status ?? e.statusCode ?? e.details?.status ?? e.response?.status));
  return Number.isInteger(s) && s > 0 ? s : null;
};

/** Texto de diagnóstico do erro (código, mensagem e corpo), só para casar o motivo; nunca é gravado. */
function diagnosticText(e) {
  const partes = [e && e.code, e && e.message, e && e.body && (typeof e.body === 'string' ? e.body : JSON.stringify(e.body)), e && e.details && e.details.body && JSON.stringify(e.details.body)];
  return partes.filter(Boolean).join(' ').slice(0, 2000);
}

/** 403 por credencial (token inválido ou expirado) é AUTH; 403 de permissão de negócio, bloqueio de conta ou política é VALIDATION. */
function isCredentialProblem(error, base) {
  if (error && error.credentialInvalid === true) return true;
  if (error && error.credentialInvalid === false) return false;
  if (base && base.class === 'AUTH' && base.code && !/^HTTP_403$/.test(base.code) && !GENERIC_CODE_RE.test(base.code)) return true;
  return CREDENTIAL_RE.test(diagnosticText(error));
}

/**
 * classifyDispatchError — a classe do erro de um envio (M9-D216 3.1). Entra o erro, a classificação do adapter (`classifyError`)
 * e o contexto ({ opClass, idempotent }). O código PRÓPRIO do fornecedor (que o adapter conhece) vale; o resto segue a tabela
 * padrão. Em DANGEROUS, timeout depois do envio e 5xx sem idempotência são UNKNOWN (INT-005: consultar antes de repetir).
 * Devolve { class, code, retryAfterMs?, reason }.
 */
function classifyDispatchError(error, base, { opClass = 'DANGEROUS', idempotent = false, now = new Date() } = {}) {
  const status = statusOf(error);
  const code = String((error && error.code) || '').toUpperCase();
  const perigosa = opClass === 'DANGEROUS';
  const retryAfterMs = (base && Number.isFinite(base.retryAfterMs) ? base.retryAfterMs : null) ?? (error && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : null) ?? parseRetryAfterMs(headerOf(error, 'retry-after'), now);
  const out = (cls, motivo, extra = {}) => ({ class: cls, code: extra.code || (status ? `HTTP_${status}` : (code || 'UNCLASSIFIED')), reason: motivo, ...(retryAfterMs !== null && cls === 'RATE_LIMIT' ? { retryAfterMs } : {}) });

  if (code === 'INTEGRATION_REQUEST_INVALID') return out('VALIDATION', 'pedido fora do schema do port', { code });
  if (code === 'INTEGRATION_RESPONSE_INVALID' || code === 'INTEGRATION_STATUS_UNMAPPED') return out('UNKNOWN', 'resposta malformada', { code });
  // Código próprio do fornecedor, mapeado pelo adapter: vale.
  if (base && CLASSES.includes(base.class) && base.code && !isGeneric(String(base.code))) {
    return { ...base, reason: 'classificação do adapter', ...(base.class === 'RATE_LIMIT' && retryAfterMs !== null ? { retryAfterMs } : {}) };
  }
  if (PRE_SEND.has(code)) return out('TRANSIENT', 'falha antes do envio');
  if (TIMEOUT.has(code) || (error && (error.name === 'AbortError' || error.name === 'TimeoutError'))) return perigosa ? out('UNKNOWN', 'timeout depois do envio') : out('TRANSIENT', 'timeout em operação segura');
  if (RESET.has(code)) return perigosa && !(error && error.beforeSend === true) ? out('UNKNOWN', 'conexão interrompida depois do envio') : out('TRANSIENT', 'conexão interrompida');
  if (status === 429) return out('RATE_LIMIT', 'limite do fornecedor');
  if (status === 401) return out('AUTH', 'credencial recusada');
  if (status === 403) return isCredentialProblem(error, base) ? out('AUTH', 'credencial recusada') : out('VALIDATION', 'recusa de negócio do fornecedor');
  if (status === 408 || status === 425) return perigosa ? out('UNKNOWN', 'tempo esgotado em operação perigosa') : out('TRANSIENT', 'tempo esgotado');
  if (status !== null && SERVER_ERRORS.has(status)) {
    if (!perigosa || idempotent || (base && base.notProcessed === true)) return out('TRANSIENT', 'erro do servidor, seguro repetir');
    return out('UNKNOWN', 'erro do servidor sem garantia de idempotência');
  }
  if (status !== null && status >= 500) return out('UNKNOWN', 'erro do servidor fora da lista');
  if (status !== null && status >= 400) return out('VALIDATION', 'recusa permanente');
  return out('UNKNOWN', 'erro sem sinal para classificar');
}

module.exports = { classifyDispatchError, isCredentialProblem, statusOf };
