'use strict';

/**
 * M9-D625 (3.1 a 3.6) — o valor consolidado de um indicador a partir dos valores das empresas permitidas:
 *   SUM  : consolidado = Σ empresas - eliminações do intercompany (os dois lados das transferências inteiras do grupo); reproduzível: soma de byCompany menos eliminations
 *   RATE : numerador e denominador das empresas somados e a taxa recalculada (nunca a média das taxas)
 * Arredonda UMA vez, no fim (M9-D605). Valor de empresa nulo (DEGRADED/INCOMPLETE) torna o consolidado nulo: não se soma o que não é confiável.
 * Par incompleto deixa o consolidado DEGRADED, sem eliminar por aproximação.
 */
const money = require('../formulas/money');
const { eliminate } = require('./intercompany');

const ORDER = ['OK', 'STALE', 'DEGRADED', 'INCOMPLETE'];
const worst = (statuses) => statuses.reduce((acc, s) => (ORDER.indexOf(s) > ORDER.indexOf(acc) ? s : acc), 'OK');
const fmt = (unit, value) => (unit === 'COUNT' ? money.count(value) : money.money(value));

function sumValue(companies, unit, elimination) {
  if (companies.some((c) => c.value === null)) return null;
  const total = money.sub(money.sum(companies.map((c) => c.value)), elimination);
  return fmt(unit, money.toString(total));
}

function rateValue(companies, rule) {
  const part = (key) => companies.map((c) => (c.dimensions[key] ? c.dimensions[key].value : null));
  const nums = part(rule.numeratorDimension);
  const dens = part(rule.denominatorDimension);
  if (companies.some((c) => c.value === null) || nums.includes(null) || dens.includes(null)) return { value: null, numerator: null, denominator: null };
  const numerator = money.toString(money.sum(nums));
  const denominator = money.toString(money.sum(dens));
  const rate = money.percent(numerator, denominator);
  return { value: rate.value, numerator: money.money(numerator), denominator: money.money(denominator), empty: rate.value === null };
}

/**
 * `companies` = saída de readCompanies; `pairs` = linhas de rm_finance_intercompany (loadPairs). Devolve
 * { value, unit, eliminations, eliminatedPairs, consolidatedStatus, unmatched, numerator?, denominator? }.
 */
function consolidate(rule, companies, pairs, { asOfDate }) {
  const unit = (companies.find((c) => c.unit) || {}).unit || null;
  const base = { unit, eliminations: '0.00', eliminatedPairs: 0, unmatched: [] };
  const statuses = companies.map((c) => c.status);
  if (rule.kind === 'RATE') {
    const r = rateValue(companies, rule);
    const status = worst([...statuses, ...(r.empty ? ['INCOMPLETE'] : [])]);
    return { ...base, value: r.value, numerator: r.numerator, denominator: r.denominator, consolidatedStatus: r.value === null && status === 'OK' ? 'INCOMPLETE' : status };
  }
  const ids = companies.map((c) => c.companyId);
  const period = (companies.find((c) => c.period) || { period: { from: asOfDate, to: asOfDate } }).period;
  const found = rule.intercompany ? eliminate(pairs, ids, rule.intercompany, { period, asOfDate }) : base;
  const value = sumValue(companies, unit, found.eliminations);
  let status = worst(statuses);
  if (found.unmatched.length && status === 'OK') status = 'DEGRADED';
  if (found.unmatched.length && status === 'STALE') status = 'DEGRADED';
  return { ...base, ...found, value, consolidatedStatus: value === null && status === 'OK' ? 'INCOMPLETE' : status };
}

module.exports = { consolidate, worst };
