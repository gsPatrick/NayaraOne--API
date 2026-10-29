'use strict';

/**
 * M9-D680 — KPI tec.queues_dlq (Filas e DLQ), versão 1. Posição: por fila (outbox e inbox) e tipo de evento, os itens aguardando (profundidade), a idade em segundos do mais antigo
 * e os que esgotaram as tentativas (DLQ). O valor é o total aguardando; o mais antigo e a DLQ total vão em dimensões e `details`. Exemplo: outbox 12, mais antigo 40 s, DLQ 3.
 * Entrada (rm_tech_queues, idade já calculada na leitura): { rows: [{ queue, eventType, depth, oldestAgeSeconds, dlqDepth }], measurementAgeMinutes }. Parâmetro: staleMinutes
 * (padrão 15). Regra de qualidade: fila sem medição há mais de staleMinutes -> STALE (mantém o valor da última medição, marcado STALE, M9-D680 6); nunca medida -> INCOMPLETE, sem valor.
 */
const money = require('./money');
const { incomplete, sumCounts, byText } = require('./_legalCorKpi');

const DEFAULT_STALE_MINUTES = 15;
const STALE_MESSAGE = 'Dado desatualizado: valor da última medição.';

const oldestOf = (rows) => {
  const ages = rows.map((r) => r.oldestAgeSeconds).filter((v) => v !== null && v !== undefined);
  return ages.length ? money.count(ages.reduce((a, v) => (money.cmp(v, a) > 0 ? v : a))) : null;
};

function compute(input, params = {}) {
  const rows = input.rows || [];
  const staleMinutes = Number.isInteger(params.staleMinutes) ? params.staleMinutes : DEFAULT_STALE_MINUTES;
  const age = input.measurementAgeMinutes;
  if (age === null || age === undefined) return incomplete('SEM_MEDICAO', {});
  const depth = sumCounts(rows.map((r) => r.depth));
  const dlq = sumCounts(rows.map((r) => r.dlqDepth));
  const oldest = oldestOf(rows);
  const dimensions = [{ key: 'dlq_qtd', value: dlq }];
  if (oldest !== null) dimensions.push({ key: 'mais_antigo_s', value: oldest });
  const queues = [...new Set(rows.map((r) => r.queue))].sort(byText);
  for (const queue of queues) {
    const own = rows.filter((r) => r.queue === queue);
    dimensions.push({ key: `fila:${queue}:profundidade_qtd`, value: sumCounts(own.map((r) => r.depth)) }, { key: `fila:${queue}:dlq_qtd`, value: sumCounts(own.map((r) => r.dlqDepth)) });
    const ownOldest = oldestOf(own);
    if (ownOldest !== null) dimensions.push({ key: `fila:${queue}:mais_antigo_s`, value: ownOldest });
  }
  const byQueue = rows.map((r) => ({ queue: r.queue, eventType: r.eventType, depth: money.count(r.depth), oldestAgeSeconds: r.oldestAgeSeconds === null || r.oldestAgeSeconds === undefined ? null : money.count(r.oldestAgeSeconds), dlqDepth: money.count(r.dlqDepth) }));
  const result = { value: depth, status: 'OK', details: { depth, oldestAgeSeconds: oldest, dlqDepth: dlq, measurementAgeMinutes: money.count(age), byQueue }, dimensions };
  if (money.cmp(age, staleMinutes) > 0) return { ...result, status: 'STALE', message: STALE_MESSAGE, details: { ...result.details, reason: 'FILA_SEM_MEDICAO', staleMinutes: String(staleMinutes) } };
  return result;
}

const row = (queue, eventType, depth, oldestAgeSeconds, dlqDepth) => ({ queue, eventType, depth, oldestAgeSeconds, dlqDepth });
const item = (queue, eventType, depth, oldest, dlq) => ({ queue, eventType, depth, oldestAgeSeconds: oldest, dlqDepth: dlq });

const testCases = [
  { kind: 'empty', name: 'nunca medida: INCOMPLETE e sem valor', input: { rows: [], measurementAgeMinutes: null }, expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'SEM_MEDICAO' }, dimensions: [] } },
  {
    kind: 'single', name: 'medida e sem item aguardando: zero, não nulo', input: { rows: [], measurementAgeMinutes: 2 },
    expected: { value: '0', status: 'OK', details: { depth: '0', oldestAgeSeconds: null, dlqDepth: '0', measurementAgeMinutes: '2', byQueue: [] }, dimensions: [{ key: 'dlq_qtd', value: '0' }] },
  },
  {
    kind: 'typical', name: 'exemplo da demanda: outbox 12, mais antigo 40 s, DLQ 3', input: { rows: [row('outbox', 'crm.x', 12, 40, 3)], measurementAgeMinutes: 1 },
    expected: {
      value: '12', status: 'OK', details: { depth: '12', oldestAgeSeconds: '40', dlqDepth: '3', measurementAgeMinutes: '1', byQueue: [item('outbox', 'crm.x', '12', '40', '3')] },
      dimensions: [{ key: 'dlq_qtd', value: '3' }, { key: 'mais_antigo_s', value: '40' }, { key: 'fila:outbox:profundidade_qtd', value: '12' }, { key: 'fila:outbox:dlq_qtd', value: '3' }, { key: 'fila:outbox:mais_antigo_s', value: '40' }],
    },
  },
  {
    kind: 'period_edge', name: 'medição com exatamente 15 minutos ainda vale; com 16 fica STALE e mantém o valor', input: { rows: [row('inbox', 'c1', 2, 5, 0)], measurementAgeMinutes: 16 },
    expected: {
      value: '2', status: 'STALE', message: 'Dado desatualizado: valor da última medição.',
      details: { depth: '2', oldestAgeSeconds: '5', dlqDepth: '0', measurementAgeMinutes: '16', byQueue: [item('inbox', 'c1', '2', '5', '0')], reason: 'FILA_SEM_MEDICAO', staleMinutes: '15' },
      dimensions: [{ key: 'dlq_qtd', value: '0' }, { key: 'mais_antigo_s', value: '5' }, { key: 'fila:inbox:profundidade_qtd', value: '2' }, { key: 'fila:inbox:dlq_qtd', value: '0' }, { key: 'fila:inbox:mais_antigo_s', value: '5' }],
    },
  },
  {
    kind: 'period_edge', name: 'o limite de medição é parâmetro (30 min): 16 min vale', input: { rows: [], measurementAgeMinutes: 16 }, params: { staleMinutes: 30 },
    expected: { value: '0', status: 'OK', details: { depth: '0', oldestAgeSeconds: null, dlqDepth: '0', measurementAgeMinutes: '16', byQueue: [] }, dimensions: [{ key: 'dlq_qtd', value: '0' }] },
  },
  {
    kind: 'rounding', name: 'contagens grandes somam exatas e o mais antigo é o maior entre as filas', input: { rows: [row('outbox', 'a', '9007199254740993', 10, 0), row('inbox', 'b', 1, 90, '9007199254740993')], measurementAgeMinutes: 0 },
    expected: {
      value: '9007199254740994', status: 'OK',
      details: { depth: '9007199254740994', oldestAgeSeconds: '90', dlqDepth: '9007199254740993', measurementAgeMinutes: '0', byQueue: [item('outbox', 'a', '9007199254740993', '10', '0'), item('inbox', 'b', '1', '90', '9007199254740993')] },
      dimensions: [
        { key: 'dlq_qtd', value: '9007199254740993' }, { key: 'mais_antigo_s', value: '90' }, { key: 'fila:inbox:profundidade_qtd', value: '1' }, { key: 'fila:inbox:dlq_qtd', value: '9007199254740993' }, { key: 'fila:inbox:mais_antigo_s', value: '90' },
        { key: 'fila:outbox:profundidade_qtd', value: '9007199254740993' }, { key: 'fila:outbox:dlq_qtd', value: '0' }, { key: 'fila:outbox:mais_antigo_s', value: '10' },
      ],
    },
  },
];

module.exports = { id: 'tec.queues_dlq', version: 1, compute, testCases };
