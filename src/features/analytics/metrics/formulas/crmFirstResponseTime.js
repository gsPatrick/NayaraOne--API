'use strict';

/**
 * M9-D630 — KPI crm.first_response_time (Tempo até a primeira resposta), versão 1. Para cada lead criado no período (mês de São Paulo da data-base) e já
 * respondido: segundos entre a criação e a primeira mensagem de saída humana. O KPI é a média aritmética desses segundos, em minutos com 1 casa
 * (meio para cima, uma vez). Lead ainda sem resposta NÃO entra na média e é contado em `details.withoutResponse`. Relógio de 24 h corridas.
 * Entrada (soma do rm_crm_lead_daily no período): { rows: [{ origin, brokerId, leads, answered, seconds }] }. Parâmetro: minSample.
 * Regra de qualidade: menos de minSample respondidos -> INCOMPLETE, valor nulo.
 */
const money = require('./money');
const { incomplete, originKey, groupSum } = require('./_crmKpi');

const average = (seconds, answered) => money.round(money.div(seconds, money.mul(answered, 60)), 1);

/** Média em minutos por chave (origem ou corretor), só onde houve resposta; ordenada pela chave. */
function averages(rows, keyOf, prefix) {
  const seconds = groupSum(rows, keyOf, (r) => r.seconds);
  const answered = groupSum(rows, keyOf, (r) => r.answered);
  return [...answered.entries()].filter(([, n]) => money.cmp(n, 0) > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, n]) => ({ key: `${prefix}:${key}:tempo_min`, value: average(seconds.get(key), n) }));
}

function compute(input, params = {}) {
  const minSample = Number.isInteger(params.minSample) ? params.minSample : 5;
  const rows = input.rows || [];
  const leads = money.count(money.sum(rows.map((r) => r.leads || 0)));
  const answered = money.count(money.sum(rows.map((r) => r.answered || 0)));
  const seconds = money.toString(money.sum(rows.map((r) => r.seconds || 0)));
  const withoutResponse = money.count(money.sub(leads, answered));
  const dimensions = [{ key: 'sem_resposta_qtd', value: withoutResponse }];
  const details = { leads, answered, withoutResponse, minSample: String(minSample) };
  if (money.cmp(answered, minSample) < 0) return incomplete('AMOSTRA_INSUFICIENTE', details, dimensions);
  dimensions.push(...averages(rows, (r) => originKey(r.origin), 'origem'), ...averages(rows, (r) => r.brokerId, 'corretor'));
  return { value: average(seconds, answered), status: 'OK', details: { ...details, averageSeconds: money.round(money.div(seconds, answered), 0) }, dimensions };
}

const row = (origin, leads, answered, seconds, brokerId = 'b1') => ({ origin, brokerId, leads, answered, seconds });
const short = (answered, withoutResponse) => ({
  value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.',
  details: { reason: 'AMOSTRA_INSUFICIENTE', leads: String(Number.parseInt(answered, 10) + Number.parseInt(withoutResponse, 10)), answered, withoutResponse, minSample: '5' }, dimensions: [{ key: 'sem_resposta_qtd', value: withoutResponse }],
});

const testCases = [
  { kind: 'empty', name: 'nenhum lead no período: sem amostra, INCOMPLETE e sem valor', input: { rows: [] }, expected: short('0', '0') },
  { kind: 'single', name: 'um respondido não basta com o mínimo de 5', input: { rows: [row('SITE', 1, 1, 600)] }, expected: short('1', '0') },
  {
    kind: 'typical', name: 'exemplo da demanda: respostas em 10, 20 e 12 min => 14,0 min (mínimo 3)', params: { minSample: 3 },
    input: { rows: [row('PORTAL', 2, 2, 1320, 'b1'), row('SITE', 2, 1, 1200, 'b2')] },
    expected: {
      value: '14.0', status: 'OK', details: { leads: '4', answered: '3', withoutResponse: '1', minSample: '3', averageSeconds: '840' },
      dimensions: [
        { key: 'sem_resposta_qtd', value: '1' }, { key: 'origem:PORTAL:tempo_min', value: '11.0' }, { key: 'origem:SITE:tempo_min', value: '20.0' },
        { key: 'corretor:b1:tempo_min', value: '11.0' }, { key: 'corretor:b2:tempo_min', value: '20.0' },
      ],
    },
  },
  {
    kind: 'period_edge', name: 'quatro respondidos com o mínimo padrão de 5: INCOMPLETE; o quinto libera o valor',
    input: { rows: [row('SITE', 5, 4, 2400)] }, expected: short('4', '1'),
  },
  {
    kind: 'rounding', name: 'cinco respostas somando 2.100 s => média 7,0 min; 100 s => 1,7 min (meio para cima, 1 casa)', params: { minSample: 1 },
    input: { rows: [row('SITE', 1, 1, 100)] },
    expected: {
      value: '1.7', status: 'OK', details: { leads: '1', answered: '1', withoutResponse: '0', minSample: '1', averageSeconds: '100' },
      dimensions: [{ key: 'sem_resposta_qtd', value: '0' }, { key: 'origem:SITE:tempo_min', value: '1.7' }, { key: 'corretor:b1:tempo_min', value: '1.7' }],
    },
  },
  {
    kind: 'rounding', name: 'lead sem resposta fica fora da média e é contado à parte', input: { rows: [row('SITE', 7, 5, 2100)] },
    expected: {
      value: '7.0', status: 'OK', details: { leads: '7', answered: '5', withoutResponse: '2', minSample: '5', averageSeconds: '420' },
      dimensions: [{ key: 'sem_resposta_qtd', value: '2' }, { key: 'origem:SITE:tempo_min', value: '7.0' }, { key: 'corretor:b1:tempo_min', value: '7.0' }],
    },
  },
];

module.exports = { id: 'crm.first_response_time', version: 1, compute, testCases };
