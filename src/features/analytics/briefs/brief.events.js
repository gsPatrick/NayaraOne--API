'use strict';

/**
 * M9-D694 (3.4) — evento `analytics.brief.item_blocked`: cada item do briefing removido pelo grounding sai com o motivo, para a equipe de
 * avaliação do Bloco A (golden dataset "NAY inventa causa") e para a auditoria. O aviso só sai DEPOIS do commit da transação que gravou o
 * briefing. O payload não leva o texto do item removido (pode conter o número ou a causa inventada): leva o código, o motivo e as referências.
 */
const logger = require('../../../utils/logger');

const TYPES = Object.freeze({ ITEM_BLOCKED: 'analytics.brief.item_blocked' });
const listeners = [];

/** fn(payload). Devolve a função que cancela a assinatura. */
function onBriefEvent(fn) {
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

function deliver(payload) {
  logger.warn({ event: payload.type, code: payload.code, refId: payload.refId, briefType: payload.briefType, companyId: payload.companyId, reason: payload.reason }, '[analytics] item do briefing bloqueado pelo grounding');
  for (const fn of [...listeners]) {
    try { fn(payload); } catch (err) { logger.error({ event: 'analytics.brief.listener_failed', err }, '[analytics] assinante do evento do briefing falhou'); }
  }
}

const rootOf = (transaction) => {
  let t = transaction;
  while (t && t.parent) t = t.parent;
  return t;
};

function emitBriefEvent(transaction, payload) {
  const root = rootOf(transaction);
  if (root && typeof root.afterCommit === 'function') root.afterCommit(() => deliver(payload));
  else deliver(payload);
}

module.exports = { TYPES, onBriefEvent, emitBriefEvent };
