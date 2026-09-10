'use strict';

const { dispatchPendingEvents } = require('../events/outbox-dispatcher');

/**
 * outboxDispatcherJob — TEC-06/TEC-07 (homologação 10/09/2026): `dispatchPendingEvents`
 * (src/engines/events/outbox-dispatcher.js) já implementa corretamente o padrão Outbox com
 * retry/backoff/DLQ (SELECT ... FOR UPDATE SKIP LOCKED, backoff 1m/5m/15m/1h/4h, DEAD_LETTER
 * após esgotar as tentativas) — mas nunca era chamado por nada: nenhum cron, nenhum worker,
 * nenhum setInterval. Todo evento gravado no outbox ficava PENDING para sempre. Mesmo padrão
 * de agendamento já usado por radarMatchingJob.js — roda dentro do próprio processo da API
 * (sem exigir fila/infra nova no Easypanel), uma vez ao iniciar e depois a cada intervalo.
 */
const DEFAULT_INTERVAL_MS = 30 * 1000; // 30 segundos

function startOutboxDispatcherJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  dispatchPendingEvents().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[OutboxDispatcherJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    dispatchPendingEvents().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[OutboxDispatcherJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = { startOutboxDispatcherJob };
