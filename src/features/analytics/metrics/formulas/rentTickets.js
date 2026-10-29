'use strict';

/**
 * M9-D642 — KPI rent.tickets (Chamados da locação), versão 1. Chamados de manutenção de imóveis com contrato de locação. O valor é a POSIÇÃO no fim do dia-base: os que seguem em aberto
 * (OPEN ou IN_PROGRESS). No período (de 1º do mês de São Paulo até a data-base) saem os abertos, os fechados e o tempo médio de resolução = horas de resolução dos fechados no período ÷
 * fechados no período, em horas com 1 casa, arredondado uma só vez (sem fechados no período, não há média). Entrada (rm_rental_tickets, linha do dia-base): { row: { openTotal,
 * openedPeriod, closedPeriod, hoursPeriod, withoutOpenDate } | null }. Regra de qualidade: chamado fechado sem data de abertura (ausente ou posterior ao fechamento) -> DEGRADED;
 * retrato do dia ainda não calculado ou campo nulo -> DEGRADED. Valor sempre nulo nesses casos.
 */
const money = require('./money');
const { degraded } = require('./_legalCorKpi');

const FIELDS = ['openTotal', 'openedPeriod', 'closedPeriod', 'hoursPeriod', 'withoutOpenDate'];

function compute(input) {
  const row = input.row;
  if (!row || FIELDS.some((f) => row[f] === null || row[f] === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', {});
  const withoutOpenDate = money.count(row.withoutOpenDate);
  if (money.cmp(withoutOpenDate, 0) > 0) return degraded('CHAMADO_SEM_DATA_DE_ABERTURA', { withoutOpenDate });
  const open = money.count(row.openTotal);
  const opened = money.count(row.openedPeriod);
  const closed = money.count(row.closedPeriod);
  const average = money.cmp(closed, 0) > 0 ? money.hours(money.div(row.hoursPeriod, closed)) : null;
  const dimensions = [{ key: 'abertos_periodo_qtd', value: opened }, { key: 'fechados_periodo_qtd', value: closed }];
  if (average !== null) dimensions.push({ key: 'tempo_medio_resolucao_horas', value: average });
  return { value: open, status: 'OK', details: { open, openedInPeriod: opened, closedInPeriod: closed, averageResolutionHours: average }, dimensions };
}

const row = (openTotal, openedPeriod, closedPeriod, hoursPeriod, withoutOpenDate = 0) => ({ openTotal, openedPeriod, closedPeriod, hoursPeriod, withoutOpenDate });
const okOf = (open, opened, closed, average) => ({
  value: open, status: 'OK', details: { open, openedInPeriod: opened, closedInPeriod: closed, averageResolutionHours: average },
  dimensions: [{ key: 'abertos_periodo_qtd', value: opened }, { key: 'fechados_periodo_qtd', value: closed }, ...(average === null ? [] : [{ key: 'tempo_medio_resolucao_horas', value: average }])],
});
const bad = (reason, details) => ({ value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhum chamado: zero em aberto e sem média', input: { row: row(0, 0, 0, '0.00') }, expected: okOf('0', '0', '0', null) },
  { kind: 'single', name: 'um chamado fechado em 12,5 horas', input: { row: row(0, 1, 1, '12.50') }, expected: okOf('0', '1', '1', '12.5') },
  { kind: 'typical', name: 'exemplo da demanda: 18 em aberto, 41 fechados, média 52,3 h', input: { row: row(18, 30, 41, '2144.30') }, expected: okOf('18', '30', '41', '52.3') },
  { kind: 'period_edge', name: 'chamado fechado sem data de abertura: DEGRADED e sem valor', input: { row: row(5, 3, 2, '10.00', 1) }, expected: bad('CHAMADO_SEM_DATA_DE_ABERTURA', { withoutOpenDate: '1' }) },
  { kind: 'period_edge', name: 'retrato do dia ainda não calculado: DEGRADED e sem valor', input: { row: null }, expected: bad('READ_MODEL_NAO_RECALCULADO', {}) },
  { kind: 'rounding', name: 'média de 18,625 horas arredonda uma vez para 18,6 (meio para cima só no fim)', input: { row: row(3, 6, 4, '74.50') }, expected: okOf('3', '6', '4', '18.6') },
  { kind: 'rounding', name: 'média de 0,05 hora arredonda para 0,1 (meio para cima)', input: { row: row(0, 2, 2, '0.10') }, expected: okOf('0', '2', '2', '0.1') },
];

module.exports = { id: 'rent.tickets', version: 1, compute, testCases };
