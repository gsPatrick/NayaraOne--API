'use strict';

/**
 * M9-D702 (3.1) — período e data-base de uma consulta de BI, pelo resolvedor único da M9-D606 (calendário de São Paulo).
 * Entradas: `period` (AAAA-MM, AAAA-Qn ou AAAA) ou `month`/`quarter`/`year` ou `from`+`to` (uma família por vez) e `asOf`.
 * Data-base: `asOf` quando informada (precisa estar dentro do período); senão o fim do período, ou hoje quando ele ainda não terminou.
 * Sem período, vale o mês da data-base (o de `asOf`, ou o mês corrente), que é a janela que os indicadores já gravam no snapshot.
 */
const AppError = require('../../../utils/AppError');
const { resolvePeriod, resolveAsOf, PERIOD_INVALID } = require('./period');
const clock = require('./clock');
const dates = require('./period.dates');

const PERIOD_FORMS = [[/^\d{4}-\d{2}$/, 'month'], [/^\d{4}-Q[1-4]$/, 'quarter'], [/^\d{4}$/, 'year']];
const FAMILIES = ['month', 'quarter', 'year', 'from', 'to'];
const present = (v) => v !== undefined && v !== null && v !== '';
const invalid = () => AppError.badRequest(PERIOD_INVALID, 'ANALYTICS_PERIOD_INVALID');

function familyOf(query) {
  const given = {};
  for (const name of [...FAMILIES, 'period', 'asOf']) {
    if (present(query[name]) && typeof query[name] !== 'string') throw invalid(); // repetido (?period=a&period=b) ou objeto
    if (present(query[name])) given[name] = query[name];
  }
  if (given.period !== undefined) {
    if (FAMILIES.some((name) => given[name] !== undefined)) throw invalid(); // `period` e outra forma juntos
    const form = PERIOD_FORMS.find(([re]) => re.test(given.period));
    if (!form) throw invalid();
    return { family: { [form[1]]: given.period }, asOf: given.asOf };
  }
  const family = Object.fromEntries(FAMILIES.filter((name) => given[name] !== undefined).map((name) => [name, given[name]]));
  return { family, asOf: given.asOf };
}

/** { period, asOfDate }: `period` traz startDate, endDate, label, kind (e os instantes do resolvedor); `asOfDate` é a data-base do snapshot. */
function resolveQueryPeriod(query) {
  const { family, asOf } = familyOf(query);
  const today = clock.businessToday();
  const asOfDate = resolveAsOf(asOf); // formato inválido: 400 ANALYTICS_PERIOD_INVALID; futuro: 400 ANALYTICS_AS_OF_FUTURE
  const hasFamily = Object.keys(family).length > 0;
  const period = resolvePeriod(hasFamily ? family : { month: dates.monthKey(asOfDate) });
  if (asOf !== undefined) {
    if (asOfDate < period.startDate || asOfDate > period.endDate) throw invalid(); // a posição em data passada precisa estar dentro do período
    return { period, asOfDate };
  }
  if (period.startDate > today) throw AppError.badRequest('A data-base não pode estar no futuro.', 'ANALYTICS_AS_OF_FUTURE');
  return { period, asOfDate: period.endDate < today ? period.endDate : today };
}

/** Período padrão de uma data-base (o mês dela): o que um painel monta quando ninguém pediu período. */
const defaultPeriodOf = (asOfDate) => resolvePeriod({ month: dates.monthKey(asOfDate) });

/** Bloco `period` da resposta (M9-D702 3.1). */
const periodView = (period, asOfDate) => ({ start: period.startDate, end: period.endDate, asOf: asOfDate, tz: 'America/Sao_Paulo', label: period.label, kind: period.kind });

module.exports = { resolveQueryPeriod, periodView, defaultPeriodOf };
