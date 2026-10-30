'use strict';

const { mktError } = require('../../../marketing.errors');

/** Erros das redes sociais (M9-D428 §4): código MKT_ e mensagem em português, sem detalhe técnico do provedor. */
const capabilityViolation = (details) => mktError(422, 'MKT_CAPABILITY_VIOLATION', 'O conteúdo excede um limite da rede escolhida.', details);
const providerAuthFailed = (details) => mktError(409, 'MKT_PROVIDER_AUTH_FAILED', 'A conexão da rede precisa ser reautorizada.', details);
const providerUnavailable = (details) => mktError(503, 'MKT_PROVIDER_UNAVAILABLE', 'A rede está indisponível; a publicação será tentada novamente com segurança.', details);

const AUTH_CODE = 'MKT_PROVIDER_AUTH_FAILED';
const UNAVAILABLE_CODE = 'MKT_PROVIDER_UNAVAILABLE';

/**
 * Normaliza o erro de um resultado de publicação para o código do Marketing: credencial recusada (classe AUTH) vira MKT_PROVIDER_AUTH_FAILED e rede fora do ar ou
 * limite de chamadas (TRANSIENT e RATE_LIMIT) vira MKT_PROVIDER_UNAVAILABLE. A classe, o HTTP e o Retry-After seguem como vieram; o resto (UNKNOWN, VALIDATION) não muda.
 */
function normalizeResultError(result) {
  const error = result && result.error;
  if (!error) return result;
  if (error.class === 'AUTH') return { ...result, error: { ...error, code: AUTH_CODE } };
  if (['TRANSIENT', 'RATE_LIMIT'].includes(error.class)) return { ...result, error: { ...error, code: UNAVAILABLE_CODE } };
  return result;
}

/** Para quem chama de forma síncrona (tela, API): resultado com credencial recusada vira 409 e rede indisponível vira 503; o resto passa. */
function assertSocialResult(result) {
  const error = result && result.error;
  if (!error) return result;
  if (error.class === 'AUTH') throw providerAuthFailed({ httpStatus: error.httpStatus ?? null });
  if (['TRANSIENT', 'RATE_LIMIT'].includes(error.class)) throw providerUnavailable({ httpStatus: error.httpStatus ?? null, ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) });
  return result;
}

module.exports = { capabilityViolation, providerAuthFailed, providerUnavailable, normalizeResultError, assertSocialResult, AUTH_CODE, UNAVAILABLE_CODE };
