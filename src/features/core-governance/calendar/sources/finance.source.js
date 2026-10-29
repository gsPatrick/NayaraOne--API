'use strict';

const { dueFromDateValue } = require('./time');
const { lifecycle, ownerOf } = require('./lifecycle');

/** Fontes BILLING (cronograma de cobrança) e FISCAL (obrigação fiscal) — M9-D802 §3.1.1. Sem responsável, vale o papel configurado. */
const billing = lifecycle('BILLING', (p, ctx) => {
  const dueAt = dueFromDateValue(p.dueDate);
  return dueAt && {
    title: `Cobrança ${p.period || ''}${p.contractNumber ? ` do contrato ${p.contractNumber}` : ''}`.trim(),
    dueAt,
    deepLink: `/painel/financeiro/cobrancas/${p.id}`,
    ...ownerOf(p.responsibleUserId, 'BILLING', ctx),
  };
});

const fiscal = lifecycle('FISCAL', (p, ctx) => {
  const dueAt = dueFromDateValue(p.dueAt);
  return dueAt && {
    title: p.description || `Obrigação fiscal ${p.obligationType || ''} ${p.referenceYear || ''}`,
    dueAt,
    deepLink: `/painel/correspondente/fiscal/${p.id}`,
    ...ownerOf(p.responsibleUserId, 'FISCAL', ctx),
  };
});

const EVENT_MAPPERS = {
  'billing.schedule_item.upserted': billing.upsert,
  'billing.schedule_item.paid': billing.done,
  'billing.schedule_item.cancelled': billing.cancelled,
  'fiscal.obligation.upserted': fiscal.upsert,
  'fiscal.obligation.fulfilled': fiscal.done,
  'fiscal.obligation.cancelled': fiscal.cancelled,
};

module.exports = { EVENT_MAPPERS };
