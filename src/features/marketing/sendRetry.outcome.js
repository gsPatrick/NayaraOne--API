'use strict';

/**
 * Classificação do resultado de sendMarketingMessage (verificação K=7, item 5; INT-005, INT-006 e §8 do bloco de Integrações), comum ao step de campanha e à
 * ação SEND_MESSAGE das automações (DI-M9F-1). Quem decide a nova tentativa só
 * conhece { ok, externalRef, errorCode, transient, unknown, deferred, rateLimited, retryAfterMs }:
 *  - ok: o canal aceitou (SENT);
 *  - unknown: resultado incerto (timeout): reconciliar pela chave antes de qualquer reenvio;
 *  - transient: nada saiu e a causa passa (429, 5xx, cofre fora, falha passageira): nova tentativa com backoff e limite;
 *  - deferred: segurar sem gravar nem gastar tentativa (horário de silêncio, circuito aberto);
 *  - nenhum dos três: falha DEFINITIVA (credencial, validação, conteúdo recusado, sem endereço): FAILED.
 */

/** Exceções que só seguram o destinatário (o próximo ciclo tenta de novo, sem gastar tentativa). */
const HOLD_CODES = Object.freeze(['INTEGRATION_CIRCUIT_OPEN', 'CIRCUIT_OPEN']);

const errorOf = (out) => (out && out.providerError) || null;

/** Resultado de sendMarketingMessage -> resultado classificado. */
function classifyMessageOutcome(out) {
  const status = out && out.status;
  if (status === 'SENT') return { ok: true, externalRef: out.providerRef || undefined };
  const error = errorOf(out);
  if (status === 'UNKNOWN') return { ok: false, unknown: true, errorCode: 'CHANNEL_UNKNOWN' };
  if (status === 'QUEUED') {
    const rateLimited = Boolean(error && (error.class === 'RATE_LIMIT' || error.httpStatus === 429));
    return { ok: false, transient: true, rateLimited, retryAfterMs: error && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : undefined, errorCode: (error && error.code) || 'CHANNEL_QUEUED' };
  }
  if (status === 'DEFERRED') return { ok: false, deferred: true, errorCode: 'CHANNEL_DEFERRED' };
  return { ok: false, errorCode: (out && out.code) || (error && error.code) || `CHANNEL_${status}` };
}

/** Exceção do envio (antes ou fora do canal) -> resultado classificado. 4xx do projeto é definitiva; 5xx (cofre fora, 503 do serviço) e o resto são transitórios. */
function classifySendException(err) {
  const code = (err && err.code) || 'SEND_EXCEPTION';
  if (code === 'MKT_KILL_SWITCH_ACTIVE') return { ok: false, errorCode: code };
  if (HOLD_CODES.includes(code)) return { ok: false, deferred: true, errorCode: code };
  const status = Number(err && (err.statusCode ?? err.status));
  if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 429) return { ok: false, errorCode: code };
  return { ok: false, transient: true, rateLimited: status === 429, errorCode: code };
}

module.exports = { classifyMessageOutcome, classifySendException, HOLD_CODES };
