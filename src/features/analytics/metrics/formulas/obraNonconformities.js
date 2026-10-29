'use strict';

/**
 * M9-D651 — KPI obra.nonconformities (Não conformidades), versão 1. Posição no fim do dia-base; "período" é a janela de 30 dias do read model
 * rm_project_nonconformities (M9-D618: data-base inclusive, calendário de São Paulo). Valor = abertas na data-base (COUNT); dimensões:
 * abertas_periodo_qtd (criadas no período), fechadas_periodo_qtd, tempo_medio_dias para fechar (1 casa, só quando houve fechamento no período) e as
 * abertas por causa, por equipe e por obra. Causa e equipe sem informação entram como NAO_INFORMADA.
 * Entrada: { asOfDate, rows: [{ projectId, cause, team, open, opened30d, closed30d, closeDaysSum }] }, params: { maxWithoutCausePct }.
 * Regra de qualidade: a parcela de não conformidades (abertas + fechadas no período) com causa NAO_INFORMADA acima do limite
 * (analytics.qualidade.max_sem_causa_pct, padrão 5) -> DEGRADED e valor nulo. Exatamente no limite ainda vale.
 */
const money = require('./money');
const { degraded, average, pct2, total } = require('./_obraKpi');

const NOT_INFORMED = 'NAO_INFORMADA';
const DEFAULT_MAX_PCT = 5;

/** Soma `field` por chave, devolvendo [[chave, texto]] em ordem de chave. */
function groupBy(rows, keyOf, field) {
  const map = new Map();
  for (const r of rows) map.set(keyOf(r), money.add(map.get(keyOf(r)) || 0, r[field]));
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, sum]) => [key, money.count(sum)]);
}

function compute(input, params = {}) {
  const rows = input.rows || [];
  const maxPct = params.maxWithoutCausePct === undefined ? DEFAULT_MAX_PCT : params.maxWithoutCausePct;
  const open = total(rows, (r) => r.open);
  const closed = total(rows, (r) => r.closed30d);
  const considered = money.add(open, closed);
  const withoutCause = total(rows.filter((r) => r.cause === NOT_INFORMED), (r) => money.add(r.open, r.closed30d));
  const withoutCausePct = pct2(withoutCause, considered) || '0.00';
  if (money.cmp(money.mul(withoutCause, 100), money.mul(maxPct, considered)) > 0) {
    return degraded('CAUSA_NAO_INFORMADA_ACIMA_DO_LIMITE', { withoutCausePct, maxWithoutCausePct: String(maxPct), considered: money.count(considered) });
  }
  const mean = average(total(rows, (r) => r.closeDaysSum), closed, 1);
  const dimensions = [{ key: 'abertas_periodo_qtd', value: money.count(total(rows, (r) => r.opened30d)) }, { key: 'fechadas_periodo_qtd', value: money.count(closed) }];
  if (mean !== null) dimensions.push({ key: 'tempo_medio_dias', value: mean });
  for (const [prefix, keyOf] of [['causa', (r) => r.cause], ['equipe', (r) => r.team], ['obra', (r) => r.projectId]]) {
    for (const [key, value] of groupBy(rows, keyOf, 'open')) dimensions.push({ key: `${prefix}:${key}`, value });
  }
  return {
    value: money.count(open), status: 'OK',
    details: { openAtBase: money.count(open), openedInPeriod: dimensions[0].value, closedInPeriod: dimensions[1].value, averageCloseDays: mean, withoutCausePct },
    dimensions,
  };
}

const row = (projectId, cause, team, open, opened30d, closed30d, closeDaysSum) => ({ projectId, cause, team, open, opened30d, closed30d, closeDaysSum });
const input = (rows) => ({ asOfDate: '2026-10-28', rows });
const params = { maxWithoutCausePct: 5 };
const ok = (open, opened, closed, mean, pct, extra) => ({
  value: open, status: 'OK', details: { openAtBase: open, openedInPeriod: opened, closedInPeriod: closed, averageCloseDays: mean, withoutCausePct: pct },
  dimensions: [{ key: 'abertas_periodo_qtd', value: opened }, { key: 'fechadas_periodo_qtd', value: closed }, ...(mean === null ? [] : [{ key: 'tempo_medio_dias', value: mean }]), ...extra.map(([key, value]) => ({ key, value }))],
});

const testCases = [
  { kind: 'empty', name: 'nenhuma não conformidade: zero abertas e fechadas, sem tempo médio', input: input([]), params, expected: ok('0', '0', '0', null, '0.00', []) },
  { kind: 'single', name: 'uma aberta com causa', input: input([row('a', 'MATERIAL', 'Equipe A', 1, 1, 0, 0)]), params, expected: ok('1', '1', '0', null, '0.00', [['causa:MATERIAL', '1'], ['equipe:Equipe A', '1'], ['obra:a', '1']]) },
  {
    kind: 'typical', name: 'exemplo do livro: 7 abertas, 11 fechadas, média 9,4 dias', params,
    input: input([row('a', 'MATERIAL', 'Equipe A', 4, 3, 6, 54), row('a', 'PROJETO', 'Equipe B', 3, 2, 5, 49)]),
    expected: ok('7', '5', '11', '9.4', '0.00', [['causa:MATERIAL', '4'], ['causa:PROJETO', '3'], ['equipe:Equipe A', '4'], ['equipe:Equipe B', '3'], ['obra:a', '7']]),
  },
  {
    kind: 'period_edge', name: 'exatamente no limite de causa não informada (1 de 20 = 5%) ainda vale', params,
    input: input([row('a', 'NAO_INFORMADA', 'Equipe A', 1, 1, 0, 0), row('a', 'MATERIAL', 'Equipe A', 19, 0, 0, 0)]),
    expected: ok('20', '1', '0', null, '5.00', [['causa:MATERIAL', '19'], ['causa:NAO_INFORMADA', '1'], ['equipe:Equipe A', '20'], ['obra:a', '20']]),
  },
  {
    kind: 'period_edge', name: 'acima do limite (2 de 20 = 10%): DEGRADED e sem valor', params,
    input: input([row('a', 'NAO_INFORMADA', 'NAO_INFORMADA', 2, 2, 0, 0), row('a', 'MATERIAL', 'Equipe A', 18, 0, 0, 0)]),
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'CAUSA_NAO_INFORMADA_ACIMA_DO_LIMITE', withoutCausePct: '10.00', maxWithoutCausePct: '5', considered: '20' }, dimensions: [] },
  },
  { kind: 'rounding', name: 'o tempo médio de 1 casa arredonda uma vez, meio para cima (31 ÷ 20 = 1,55 vira 1,6)', params, input: input([row('a', 'MATERIAL', 'Equipe A', 0, 0, 20, 31)]), expected: ok('0', '0', '20', '1.6', '0.00', [['causa:MATERIAL', '0'], ['equipe:Equipe A', '0'], ['obra:a', '0']]) },
];

module.exports = { id: 'obra.nonconformities', version: 1, compute, testCases, NOT_INFORMED };
