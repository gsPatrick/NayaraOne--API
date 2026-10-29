'use strict';

/**
 * M9-D691 (5) — eventos `analytics.alert.opened`, `analytics.alert.acknowledged` e `analytics.alert.resolved`. O aviso só sai DEPOIS do commit da
 * transação que gravou a mudança (transação desfeita = nenhum aviso). Quem notifica o owner e abre a tarefa (M9-D692) assina com `onAlertEvent`.
 * O payload traz o código da métrica e os ids, nunca o valor: alerta de métrica restrita não vaza número pela notificação.
 */
const logger = require('../../../utils/logger');

const listeners = [];
const TYPES = Object.freeze({ OPENED: 'analytics.alert.opened', ACKNOWLEDGED: 'analytics.alert.acknowledged', RESOLVED: 'analytics.alert.resolved' });

/** fn(payload). Devolve a função que cancela a assinatura. */
function onAlertEvent(fn) {
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

const rootOf = (transaction) => {
  let t = transaction;
  while (t && t.parent) t = t.parent;
  return t;
};

function deliver(payload) {
  logger.info({ event: payload.type, alertCode: payload.alertCode, metricCode: payload.metricCode, instanceId: payload.instanceId, companyId: payload.companyId }, '[analytics] evento de alerta');
  for (const fn of [...listeners]) {
    try {
      fn(payload);
    } catch (err) {
      logger.error({ event: 'analytics.alert.listener_failed', err }, '[analytics] assinante do evento de alerta falhou');
    }
  }
}

function emitAlertEvent(transaction, payload) {
  const root = rootOf(transaction);
  if (root && typeof root.afterCommit === 'function') root.afterCommit(() => deliver(payload));
  else deliver(payload);
}

module.exports = { TYPES, onAlertEvent, emitAlertEvent };
