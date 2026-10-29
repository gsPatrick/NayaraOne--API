'use strict';

/**
 * M9-D609 (6) — evento técnico `analytics.snapshot.failed`: o snapshot de uma métrica não pôde ser gravado. A falha de uma métrica nunca impede
 * as outras; o alerta técnico é o log de erro estruturado (mesmo padrão do `analytics.read_model.degraded`, M9-D607) mais os assinantes.
 */
const logger = require('../../../utils/logger');

const EVENT_TYPE = 'analytics.snapshot.failed';
const listeners = [];

function onSnapshotFailed(fn) {
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

function emitSnapshotFailed(payload) {
  logger.error({ event: EVENT_TYPE, ...payload }, '[analytics] snapshot diário falhou para a métrica');
  for (const fn of [...listeners]) {
    try {
      fn(payload);
    } catch (err) {
      logger.error({ event: 'analytics.snapshot.listener_failed', err }, '[analytics] assinante do evento de falha de snapshot falhou');
    }
  }
}

module.exports = { EVENT_TYPE, onSnapshotFailed, emitSnapshotFailed };
