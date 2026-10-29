'use strict';

/**
 * M9-D651 — KPI obra.delays (Atrasos), versão 1. Posição no fim do dia-base. Etapa atrasada = fim previsto (data de calendário de São Paulo) antes
 * da data-base, etapa não concluída e progresso medido abaixo de 100%; dias de atraso = diferença em dias de calendário entre a data-base e o fim
 * previsto (o read model rm_project_delays, M9-D618, já traz isso por obra). Valor = número de etapas atrasadas da empresa (COUNT); dimensões:
 * maximo_dias, medio_dias (1 casa), obras_com_atraso_qtd e, por obra com atraso, a contagem e o maior atraso.
 * Entrada: { asOfDate, projects: [{ id, delayedStages, maxDelayDays, delayDaysSum, stagesWithoutDate }] }. Regra de qualidade: etapa sem data
 * prevista em qualquer obra -> INCOMPLETE e valor nulo (o atraso dela não pode ser medido).
 */
const money = require('./money');
const { incomplete, average, sortedById, total } = require('./_obraKpi');

function compute(input) {
  const projects = sortedById(input.projects);
  if (!projects.length) return incomplete('SEM_OBRA', { projects: '0', stagesWithoutDate: '0' });
  const withoutDate = money.count(total(projects, (p) => p.stagesWithoutDate || 0));
  if (withoutDate !== '0') return incomplete('ETAPA_SEM_DATA_PREVISTA', { projects: String(projects.length), stagesWithoutDate: withoutDate });
  const delayed = money.count(total(projects, (p) => p.delayedStages));
  const late = projects.filter((p) => money.cmp(p.delayedStages, 0) > 0);
  const max = late.reduce((m, p) => (money.cmp(p.maxDelayDays, m) > 0 ? p.maxDelayDays : m), '0');
  const mean = delayed === '0' ? '0.0' : average(total(late, (p) => p.delayDaysSum), delayed, 1);
  const dimensions = [
    { key: 'maximo_dias', value: money.count(max) }, { key: 'medio_dias', value: mean }, { key: 'obras_com_atraso_qtd', value: String(late.length) },
  ];
  for (const p of late) dimensions.push({ key: `obra:${p.id}`, value: money.count(p.delayedStages) }, { key: `obra:${p.id}:maximo_dias`, value: money.count(p.maxDelayDays) });
  return { value: delayed, status: 'OK', details: { delayedStages: delayed, maxDelayDays: dimensions[0].value, meanDelayDays: mean, projectsWithDelay: String(late.length), projects: String(projects.length) }, dimensions };
}

const project = (id, delayedStages, maxDelayDays, delayDaysSum, stagesWithoutDate = 0) => ({ id, delayedStages, maxDelayDays, delayDaysSum, stagesWithoutDate });
const input = (projects) => ({ asOfDate: '2026-10-28', projects });
const ok = (delayed, max, mean, withDelay, projects, per) => ({
  value: delayed, status: 'OK', details: { delayedStages: delayed, maxDelayDays: max, meanDelayDays: mean, projectsWithDelay: withDelay, projects },
  dimensions: [{ key: 'maximo_dias', value: max }, { key: 'medio_dias', value: mean }, { key: 'obras_com_atraso_qtd', value: withDelay }, ...per.flatMap(([id, n, m]) => [{ key: `obra:${id}`, value: n }, { key: `obra:${id}:maximo_dias`, value: m }])],
});

const testCases = [
  { kind: 'empty', name: 'nenhuma obra: INCOMPLETE e sem valor', input: input([]), expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'SEM_OBRA', projects: '0', stagesWithoutDate: '0' }, dimensions: [] } },
  { kind: 'single', name: 'uma obra sem etapa atrasada: zero, média 0,0', input: input([project('a', 0, 0, 0)]), expected: ok('0', '0', '0.0', '0', '1', []) },
  {
    kind: 'typical', name: 'exemplo do livro: 3 etapas atrasadas, máximo 12 dias, média 7,7 em 2 obras', input: input([project('a', 2, 12, 20), project('b', 1, 3, 3)]),
    expected: ok('3', '12', '7.7', '2', '2', [['a', '2', '12'], ['b', '1', '3']]),
  },
  {
    kind: 'period_edge', name: 'etapa sem data prevista: INCOMPLETE e sem valor', input: input([project('a', 1, 5, 5, 1)]),
    expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'ETAPA_SEM_DATA_PREVISTA', projects: '1', stagesWithoutDate: '1' }, dimensions: [] },
  },
  { kind: 'rounding', name: 'a média de 1 casa arredonda uma vez, meio para cima (31 ÷ 20 = 1,55 vira 1,6)', input: input([project('a', 20, 4, 31)]), expected: ok('20', '4', '1.6', '1', '1', [['a', '20', '4']]) },
];

module.exports = { id: 'obra.delays', version: 1, compute, testCases };
