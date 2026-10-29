'use strict';

/**
 * M9-D632 — KPI crm.visits (Visitas), versão 1. Valor = visitas agendadas no período (canceladas fora, pela data da visita em São Paulo); a taxa
 * de comparecimento = realizadas ÷ agendadas × 100 (2 casas, uma vez) e as realizadas vão em dimensões, com as visitas por corretor. Entrada (soma
 * dos dias do período no rm_crm_visits_proposals): { scheduled, done, withoutBroker, byBroker: { corretor: { s, d } } }. Regra de qualidade: visita
 * sem corretor no período -> DEGRADED, valor nulo. Sem visita agendada a taxa não existe (sem dimensão), nunca vira 0%.
 */
const money = require('./money');
const { degraded, count, brokerDimensions } = require('./_bizKpi');

function compute(input) {
  const scheduled = count(input.scheduled);
  const done = count(input.done);
  const withoutBroker = count(input.withoutBroker);
  const details = { scheduled, done, withoutBroker };
  if (withoutBroker !== '0') return degraded('VISITA_SEM_CORRETOR', details, [{ key: 'realizadas', value: done }]);
  const rate = money.percent(done, scheduled);
  const dimensions = [{ key: 'realizadas', value: done }];
  if (rate.value !== null) dimensions.push({ key: 'comparecimento_pct', value: rate.value });
  dimensions.push(...brokerDimensions(input.byBroker, { s: 'agendadas', d: 'realizadas' }));
  return { value: scheduled, status: 'OK', details: { ...details, attendancePct: rate.value }, dimensions };
}

const input = (extra = {}) => ({ scheduled: 60, done: 48, withoutBroker: 0, byBroker: { b1: { s: 40, d: 32 }, b2: { s: 20, d: 16 } }, ...extra });
const okOf = (scheduled, done, pct, brokers = []) => ({
  value: scheduled, status: 'OK', details: { scheduled, done, withoutBroker: '0', attendancePct: pct },
  dimensions: [{ key: 'realizadas', value: done }, ...(pct === null ? [] : [{ key: 'comparecimento_pct', value: pct }]), ...brokers],
});

const testCases = [
  { kind: 'empty', name: 'nenhuma visita no período: zero e sem taxa (nunca 0%)', input: input({ scheduled: 0, done: 0, byBroker: {} }), expected: okOf('0', '0', null) },
  {
    kind: 'single', name: 'uma visita agendada e ainda não realizada: taxa 0,00%', input: input({ scheduled: 1, done: 0, byBroker: { b1: { s: 1, d: 0 } } }),
    expected: okOf('1', '0', '0.00', [{ key: 'corretor:b1:agendadas', value: '1' }, { key: 'corretor:b1:realizadas', value: '0' }]),
  },
  {
    kind: 'typical', name: 'exemplo do livro: 60 agendadas, 48 realizadas => 80,00%', input: input(),
    expected: okOf('60', '48', '80.00', [
      { key: 'corretor:b1:agendadas', value: '40' }, { key: 'corretor:b1:realizadas', value: '32' }, { key: 'corretor:b2:agendadas', value: '20' }, { key: 'corretor:b2:realizadas', value: '16' },
    ]),
  },
  { kind: 'period_edge', name: 'contagens vindas como texto do banco entram como inteiros', input: input({ scheduled: '3', done: '3', byBroker: {} }), expected: okOf('3', '3', '100.00') },
  { kind: 'rounding', name: 'taxa 2 de 3 arredonda uma vez, meio para cima: 66,67%', input: input({ scheduled: 3, done: 2, byBroker: {} }), expected: okOf('3', '2', '66.67') },
  {
    kind: 'period_edge', name: 'visita sem corretor: DEGRADED e sem valor', input: input({ withoutBroker: 2 }),
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'VISITA_SEM_CORRETOR', scheduled: '60', done: '48', withoutBroker: '2' }, dimensions: [{ key: 'realizadas', value: '48' }] },
  },
];

module.exports = { id: 'crm.visits', version: 1, compute, testCases };
