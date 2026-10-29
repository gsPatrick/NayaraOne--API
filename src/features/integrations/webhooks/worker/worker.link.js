'use strict';

const { resolveDispatchByEvent } = require('../../dispatch/reconcile/reconcile.event');

/**
 * Evento ligado a um envio (M9-D212 critério herdado da M9-D211, M9-D215): quando o evento traz a chave de idempotência ou o id do recurso do fornecedor, o worker chama
 * resolveDispatchByEvent com o status JÁ normalizado pelo adapter e a origem WEBHOOK_SIGNED. Envio em UNKNOWN se resolve na hora, sem esperar a consulta; sem envio ligado,
 * nada acontece. Roda na mesma transação do evento (sob o lock da linha do envio, o primeiro a confirmar vence).
 */
async function linkToDispatch(ctx, row, ev, internalStatus, transaction) {
  if (!internalStatus || (!ev.idempotencyKey && !ev.resourceRef)) return { matched: false };
  return resolveDispatchByEvent(ctx, {
    providerCode: row.providerCode, idempotencyKey: ev.idempotencyKey || undefined, externalResourceId: ev.resourceRef || undefined, status: internalStatus, source: 'WEBHOOK_SIGNED',
  }, {}, transaction);
}

module.exports = { linkToDispatch };
