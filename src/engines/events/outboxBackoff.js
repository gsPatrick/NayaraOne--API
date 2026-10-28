'use strict';

const { getSetting } = require('../../features/settings/settings.service');
const { parseBackoffList } = require('./outboxBackoffParse');

/** Padrão (INT-P036): o RETRY_BACKOFF_MS que o código tinha antes: 1 min, 5 min, 15 min, 1 h, 4 h. */
const DEFAULT_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
const BACKOFF_KEY = 'integration.outbox.backoff_ms';

/** Lista de esperas configurada pela empresa; sem configuração (ou inválida) vale o padrão. */
async function getOutboxBackoff(company, transaction) {
  const raw = await getSetting(BACKOFF_KEY, { companyId: company.id }, transaction, null);
  return (raw && parseBackoffList(raw)) || DEFAULT_BACKOFF_MS;
}

/** Marca falha: agenda a próxima tentativa ou envia à DLQ ao esgotar a lista (tentativas = tamanho da lista). */
function applyFailure(event, err, backoff) {
  event.retryCount += 1;
  if (event.retryCount >= backoff.length) {
    event.status = 'DEAD_LETTER';
    event.deadLetterReason = err.code ? `${err.code}: ${err.message}` : err.message;
    return 'deadLettered';
  }
  event.nextRetryAt = new Date(Date.now() + backoff[event.retryCount - 1]);
  return 'failed';
}

module.exports = { DEFAULT_BACKOFF_MS, BACKOFF_KEY, getOutboxBackoff, applyFailure };
