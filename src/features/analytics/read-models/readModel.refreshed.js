'use strict';

/**
 * M9-D698 (3.3) — evento `analytics.read_model.refreshed`: um read model da empresa acabou de ser atualizado (lote de eventos, agenda, rebuild
 * ou materialized view do grupo). Quem guarda resposta pronta (o cache dos painéis) assina com `onRefreshed` e descarta o que era da empresa.
 * O aviso só sai DEPOIS do commit da transação que gravou o refresh: avisar antes deixaria uma leitura concorrente repovoar o cache com o
 * número antigo. Transação desfeita = nenhum aviso. Mesmo processo; em várias instâncias o TTL limita a defasagem.
 */
const logger = require('../../../utils/logger');

const EVENT_TYPE = 'analytics.read_model.refreshed';
const listeners = [];

/** fn({ readModel, companyId, groupId, refreshId }). Devolve a função que cancela a assinatura. */
function onRefreshed(fn) {
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

function rootOf(transaction) {
  let t = transaction;
  while (t && t.parent) t = t.parent;
  return t;
}

function deliver(payload) {
  logger.debug({ event: EVENT_TYPE, ...payload }, '[analytics] read model atualizado');
  for (const fn of [...listeners]) {
    try {
      fn(payload);
    } catch (err) {
      logger.error({ event: 'analytics.read_model.refreshed_listener_failed', err }, '[analytics] assinante do evento de refresh falhou');
    }
  }
}

/** Agenda o aviso para depois do commit da transação raiz (ou entrega já, se não houver transação). */
function emitRefreshed(transaction, payload) {
  const root = rootOf(transaction);
  if (root && typeof root.afterCommit === 'function') root.afterCommit(() => deliver(payload));
  else deliver(payload);
}

module.exports = { EVENT_TYPE, onRefreshed, emitRefreshed };
