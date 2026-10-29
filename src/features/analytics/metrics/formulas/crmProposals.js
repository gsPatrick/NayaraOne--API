'use strict';

/**
 * M9-D632 — KPI crm.proposals (Propostas), versão 1. Valor = propostas enviadas no período (data do envio em São Paulo). Das enviadas, mostra as
 * aceitas, recusadas, expiradas e em aberto (situação de hoje), o valor total proposto em reais (natureza ESTIMATED) e a taxa de aceite =
 * aceitas ÷ (aceitas + recusadas) × 100 (expirada não é recusa do cliente). Entrada (soma dos dias no rm_crm_visits_proposals): { sent, accepted,
 * rejected, expired, open, valueSent, withoutValue, byBroker: { corretor: enviadas } }. Regra de qualidade: proposta sem valor -> DEGRADED, valor nulo.
 */
const money = require('./money');
const { degraded, count, sumCounts, brokerDimensions } = require('./_bizKpi');

function compute(input) {
  const sent = count(input.sent);
  const accepted = count(input.accepted);
  const rejected = count(input.rejected);
  const expired = count(input.expired);
  const open = count(input.open);
  const withoutValue = count(input.withoutValue);
  const other = money.count(money.sub(sent, sumCounts([accepted, rejected, expired, open])));
  const valueSent = money.money(input.valueSent || 0);
  const details = { sent, accepted, rejected, expired, open, other, valueSent, withoutValue };
  if (withoutValue !== '0') return degraded('PROPOSTA_SEM_VALOR', details);
  const rate = money.percent(accepted, money.add(accepted, rejected));
  const dimensions = [
    { key: 'aceitas', value: accepted }, { key: 'recusadas', value: rejected }, { key: 'expiradas', value: expired }, { key: 'em_aberto', value: open }, { key: 'valor_total_brl', value: valueSent },
  ];
  if (rate.value !== null) dimensions.push({ key: 'taxa_aceite_pct', value: rate.value });
  dimensions.push(...brokerDimensions(input.byBroker, 'enviadas'));
  return { value: sent, status: 'OK', details: { ...details, acceptRatePct: rate.value }, dimensions };
}

const input = (extra = {}) => ({ sent: 12, accepted: 4, rejected: 3, expired: 0, open: 5, valueSent: '2400000.00', withoutValue: 0, byBroker: { b1: 12 }, ...extra });
const okOf = (d, brokers = []) => ({
  value: d.sent, status: 'OK',
  details: { sent: d.sent, accepted: d.accepted, rejected: d.rejected, expired: d.expired, open: d.open, other: d.other || '0', valueSent: d.valueSent, withoutValue: '0', acceptRatePct: d.rate },
  dimensions: [
    { key: 'aceitas', value: d.accepted }, { key: 'recusadas', value: d.rejected }, { key: 'expiradas', value: d.expired }, { key: 'em_aberto', value: d.open }, { key: 'valor_total_brl', value: d.valueSent },
    ...(d.rate === null ? [] : [{ key: 'taxa_aceite_pct', value: d.rate }]), ...brokers,
  ],
});

const testCases = [
  { kind: 'empty', name: 'nenhuma proposta enviada: zero, sem taxa de aceite', input: input({ sent: 0, accepted: 0, rejected: 0, open: 0, valueSent: 0, byBroker: {} }), expected: okOf({ sent: '0', accepted: '0', rejected: '0', expired: '0', open: '0', valueSent: '0.00', rate: null }) },
  {
    kind: 'single', name: 'uma proposta aceita: aceite 100,00%', input: input({ sent: 1, accepted: 1, rejected: 0, open: 0, valueSent: '350000.00', byBroker: { b1: 1 } }),
    expected: okOf({ sent: '1', accepted: '1', rejected: '0', expired: '0', open: '0', valueSent: '350000.00', rate: '100.00' }, [{ key: 'corretor:b1:enviadas', value: '1' }]),
  },
  {
    kind: 'typical', name: 'exemplo do livro: 12 enviadas, 4 aceitas, 3 recusadas, 5 em aberto => aceite 57,14%', input: input(),
    expected: okOf({ sent: '12', accepted: '4', rejected: '3', expired: '0', open: '5', valueSent: '2400000.00', rate: '57.14' }, [{ key: 'corretor:b1:enviadas', value: '12' }]),
  },
  {
    kind: 'period_edge', name: 'expirada e rascunho enviado não entram na taxa e a diferença vai em other', input: input({ sent: 10, accepted: 2, rejected: 2, expired: 3, open: 2, valueSent: '1000.00', byBroker: {} }),
    expected: okOf({ sent: '10', accepted: '2', rejected: '2', expired: '3', open: '2', other: '1', valueSent: '1000.00', rate: '50.00' }),
  },
  { kind: 'rounding', name: 'valor proposto arredonda uma vez, meio para cima, e a taxa 1 de 3 vira 33,33%', input: input({ sent: 3, accepted: 1, rejected: 2, open: 0, valueSent: '10.005', byBroker: {} }), expected: okOf({ sent: '3', accepted: '1', rejected: '2', expired: '0', open: '0', valueSent: '10.01', rate: '33.33' }) },
  {
    kind: 'period_edge', name: 'proposta sem valor: DEGRADED e sem valor', input: input({ withoutValue: 1 }),
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'PROPOSTA_SEM_VALOR', sent: '12', accepted: '4', rejected: '3', expired: '0', open: '5', other: '0', valueSent: '2400000.00', withoutValue: '1' }, dimensions: [] },
  },
];

module.exports = { id: 'crm.proposals', version: 1, compute, testCases };
