'use strict';

const { publishSourceEvent } = require('../../core-governance/calendar/calendar.publisher');

/** Eventos de obrigação fiscal para o Calendário unificado (M9-D802 §3.1.1). Na transação da operação. */
function payloadOf(obligation) {
  return { obligationType: obligation.obligationType, referenceYear: obligation.referenceYear, dueAt: obligation.dueAt, description: obligation.description, status: obligation.status };
}

/** Criação ou mudança de prazo. */
function publishObligationUpserted(obligation, transaction) {
  return publishSourceEvent({ entity: obligation, aggregateType: 'FiscalObligation', eventType: 'fiscal.obligation.upserted', payload: payloadOf(obligation) }, transaction);
}

/** Conclusão (manual ou pelo fechamento do batch DIMOB): chave por obrigação, concluída uma única vez. */
function publishObligationFulfilled(obligation, transaction) {
  return publishSourceEvent({ entity: obligation, aggregateType: 'FiscalObligation', eventType: 'fiscal.obligation.fulfilled', payload: payloadOf(obligation), version: 'done' }, transaction);
}

module.exports = { publishObligationUpserted, publishObligationFulfilled };
