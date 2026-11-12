'use strict';

const { RETRY_CODES } = require('../../sendRetry.policy');

/**
 * Estados da entrega por destinatário de um step de campanha (marketing.campaign_step_deliveries; migrations 754 e 757).
 * Fechados: SENT, BLOCKED, FAILED, CANCELLED. Abertos (voltam sozinhos em next_attempt_at): RETRY (falha transitória) e UNKNOWN (resultado incerto, reconciliar antes).
 */
const STATUS = Object.freeze({ SENT: 'SENT', BLOCKED: 'BLOCKED', FAILED: 'FAILED', RETRY: 'RETRY', UNKNOWN: 'UNKNOWN', CANCELLED: 'CANCELLED' });
const OPEN_STATUSES = Object.freeze([STATUS.RETRY, STATUS.UNKNOWN]);
const ALL_STATUSES = Object.freeze(Object.values(STATUS));

/** Motivos gravados pela própria correção. */
const CODES = Object.freeze({
  ...RETRY_CODES, // tentativas ou consultas esgotadas (fila morta: só o reprocessamento do administrador reabre); o provedor confirmou que não recebeu (reenvia com a mesma chave)
  CAMPAIGN_ENDED: 'CAMPAIGN_ENDED',
  CANSEND_ERROR: 'CANSEND_ERROR',
});

/**
 * FAILED que o administrador pode reprocessar: só os que vieram de falha TRANSITÓRIA (ou de incerteza), nunca recusa definitiva (endereço inválido, conteúdo recusado,
 * credencial, validação). Inclui os códigos que o disparo gravava como FAILED antes desta correção (CHANNEL_QUEUED, CHANNEL_UNKNOWN, SEND_EXCEPTION e a falta do cofre,
 * caso da campanha cfc5c8e1 da homologação) e o BLOCKED CANSEND_ERROR (exceção passageira do canSend, gravada como bloqueio).
 */
const REPROCESSABLE_FAILED = Object.freeze([
  'MKT_UNSUBSCRIBE_KEY_UNAVAILABLE', 'INTEGRATION_SECRET_STORE_UNAVAILABLE', 'INTEGRATION_SECRET_STORE_NOT_CONFIGURED', 'INTEGRATION_SECRET_STORE_CONFIG',
  'INTEGRATION_CIRCUIT_OPEN', 'CIRCUIT_OPEN', 'CHANNEL_QUEUED', 'CHANNEL_UNKNOWN', 'CHANNEL_DEFERRED', 'SEND_EXCEPTION', 'SEND_FAILED',
  CODES.RETRIES_EXHAUSTED, CODES.UNKNOWN_EXHAUSTED,
]);
/** Desses, os que podem ter saído: voltam como UNKNOWN (reconciliar antes de qualquer reenvio). */
const REPROCESS_AS_UNKNOWN = Object.freeze(['CHANNEL_UNKNOWN', CODES.UNKNOWN_EXHAUSTED]);

const MIN_REPROCESS_REASON = 10;

module.exports = { STATUS, OPEN_STATUSES, ALL_STATUSES, CODES, REPROCESSABLE_FAILED, REPROCESS_AS_UNKNOWN, MIN_REPROCESS_REASON };
