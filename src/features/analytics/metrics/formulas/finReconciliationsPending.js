'use strict';

/**
 * M9-D624 — KPI fin.reconciliations_pending (Conciliações pendentes), versão 1. Posição no fim do dia-base: contagem e soma dos valores
 * absolutos (R$) das transações bancárias importadas, até o dia-base, sem conciliação aprovada, mais a idade em dias da mais antiga.
 * Entrada (linha do rm_finance_health): { asOfDate, count, amountAbs, oldestDate, byBand: { labels, accounts: { conta: { faixa: { count, amount } } } },
 * lastImportDate }. Parâmetro: maxStatementAgeDays. Regra de qualidade: última importação de extrato mais antiga que o parâmetro (ou
 * inexistente) -> DEGRADED e valor nulo (a pendência pode estar subestimada). Dinheiro em decimal exato, arredondado uma só vez (M9-D605).
 */
const money = require('./money');
const { daysBetween } = require('./_dates');
const { degraded, ageDays } = require('./_finKpi');

function statementProblem(input, maxAge) {
  if (!input.lastImportDate) return 'EXTRATO_AUSENTE';
  return daysBetween(input.lastImportDate, input.asOfDate) > maxAge ? 'EXTRATO_DESATUALIZADO' : null;
}

function byBandTotals(byBand) {
  const labels = byBand.labels || [];
  const totals = Object.fromEntries(labels.map((l) => [l, { count: '0', amount: '0' }]));
  const perAccount = {};
  for (const [account, bands] of Object.entries(byBand.accounts || {})) {
    perAccount[account] = '0';
    for (const [label, cell] of Object.entries(bands)) {
      const t = totals[label] || (totals[label] = { count: '0', amount: '0' });
      t.count = money.toString(money.add(t.count, cell.count));
      t.amount = money.toString(money.add(t.amount, cell.amount));
      perAccount[account] = money.toString(money.add(perAccount[account], cell.count));
    }
  }
  return { labels, totals, perAccount };
}

function compute(input, params = {}) {
  const maxAge = Number.isInteger(params.maxStatementAgeDays) ? params.maxStatementAgeDays : 3;
  const problem = statementProblem(input, maxAge);
  const age = input.lastImportDate ? String(daysBetween(input.lastImportDate, input.asOfDate)) : null;
  if (problem) return degraded(problem, { statementAgeDays: age, maxStatementAgeDays: String(maxAge) });
  const { labels, totals, perAccount } = byBandTotals(input.byBand || {});
  const oldestAgeDays = ageDays(input.oldestDate, input.asOfDate);
  const amountBrl = money.money(input.amountAbs);
  const dimensions = [{ key: 'valor_brl', value: amountBrl }];
  if (oldestAgeDays !== null) dimensions.push({ key: 'mais_antiga_dias', value: oldestAgeDays });
  for (const label of labels) dimensions.push({ key: `faixa:${label}`, value: money.count(totals[label].count) });
  for (const account of Object.keys(perAccount).sort()) dimensions.push({ key: `conta:${account}`, value: money.count(perAccount[account]) });
  return {
    value: money.count(input.count),
    status: 'OK',
    details: {
      count: money.count(input.count), amountBrl, oldestAgeDays, statementAgeDays: age,
      bands: labels.map((l) => ({ band: l, count: money.count(totals[l].count), amountBrl: money.money(totals[l].amount) })),
    },
    dimensions,
  };
}

const row = (extra = {}) => ({
  asOfDate: '2026-10-28', count: 14, amountAbs: '9300.00', oldestDate: '2026-10-22', lastImportDate: '2026-10-27',
  byBand: { labels: ['0-2', '3-7', '8+'], accounts: { 'conta-1': { '0-2': { count: 6, amount: '3000.00' }, '3-7': { count: 8, amount: '6300.00' } } } }, ...extra,
});
const params = { maxStatementAgeDays: 3 };

const testCases = [
  {
    kind: 'empty', name: 'sem pendência', input: row({ count: 0, amountAbs: '0.00', oldestDate: null, byBand: { labels: ['0-2', '3-7', '8+'], accounts: {} } }), params,
    expected: {
      value: '0', status: 'OK',
      details: { count: '0', amountBrl: '0.00', oldestAgeDays: null, statementAgeDays: '1', bands: [{ band: '0-2', count: '0', amountBrl: '0.00' }, { band: '3-7', count: '0', amountBrl: '0.00' }, { band: '8+', count: '0', amountBrl: '0.00' }] },
      dimensions: [{ key: 'valor_brl', value: '0.00' }, { key: 'faixa:0-2', value: '0' }, { key: 'faixa:3-7', value: '0' }, { key: 'faixa:8+', value: '0' }],
    },
  },
  {
    kind: 'single', name: 'uma transação', params,
    input: row({ count: 1, amountAbs: '10.50', oldestDate: '2026-10-28', byBand: { labels: ['0-2', '3-7', '8+'], accounts: { c: { '0-2': { count: 1, amount: '10.50' } } } } }),
    expected: {
      value: '1', status: 'OK',
      details: { count: '1', amountBrl: '10.50', oldestAgeDays: '0', statementAgeDays: '1', bands: [{ band: '0-2', count: '1', amountBrl: '10.50' }, { band: '3-7', count: '0', amountBrl: '0.00' }, { band: '8+', count: '0', amountBrl: '0.00' }] },
      dimensions: [{ key: 'valor_brl', value: '10.50' }, { key: 'mais_antiga_dias', value: '0' }, { key: 'faixa:0-2', value: '1' }, { key: 'faixa:3-7', value: '0' }, { key: 'faixa:8+', value: '0' }, { key: 'conta:c', value: '1' }],
    },
  },
  {
    kind: 'typical', name: 'exemplo da demanda: 14 transações, 9.300,00, mais antiga 6 dias', input: row(), params,
    expected: {
      value: '14', status: 'OK',
      details: { count: '14', amountBrl: '9300.00', oldestAgeDays: '6', statementAgeDays: '1', bands: [{ band: '0-2', count: '6', amountBrl: '3000.00' }, { band: '3-7', count: '8', amountBrl: '6300.00' }, { band: '8+', count: '0', amountBrl: '0.00' }] },
      dimensions: [{ key: 'valor_brl', value: '9300.00' }, { key: 'mais_antiga_dias', value: '6' }, { key: 'faixa:0-2', value: '6' }, { key: 'faixa:3-7', value: '8' }, { key: 'faixa:8+', value: '0' }, { key: 'conta:conta-1', value: '14' }],
    },
  },
  {
    kind: 'period_edge', name: 'extrato com exatamente 3 dias ainda vale; com 4 dias é DEGRADED', params,
    input: row({ lastImportDate: '2026-10-25' }),
    expected: {
      value: '14', status: 'OK',
      details: { count: '14', amountBrl: '9300.00', oldestAgeDays: '6', statementAgeDays: '3', bands: [{ band: '0-2', count: '6', amountBrl: '3000.00' }, { band: '3-7', count: '8', amountBrl: '6300.00' }, { band: '8+', count: '0', amountBrl: '0.00' }] },
      dimensions: [{ key: 'valor_brl', value: '9300.00' }, { key: 'mais_antiga_dias', value: '6' }, { key: 'faixa:0-2', value: '6' }, { key: 'faixa:3-7', value: '8' }, { key: 'faixa:8+', value: '0' }, { key: 'conta:conta-1', value: '14' }],
    },
  },
  {
    kind: 'period_edge', name: 'extrato mais antigo que o limite: DEGRADED sem valor', input: row({ lastImportDate: '2026-10-24' }), params,
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'EXTRATO_DESATUALIZADO', statementAgeDays: '4', maxStatementAgeDays: '3' }, dimensions: [] },
  },
  {
    kind: 'period_edge', name: 'nenhuma importação de extrato: DEGRADED sem valor', input: row({ lastImportDate: null }), params,
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'EXTRATO_AUSENTE', statementAgeDays: null, maxStatementAgeDays: '3' }, dimensions: [] },
  },
  {
    kind: 'rounding', name: 'valor com mais de 2 casas arredonda uma só vez, meio para cima', params,
    input: row({ count: 3, amountAbs: '0.335', oldestDate: '2026-10-28', byBand: { labels: ['0-2', '3-7', '8+'], accounts: { c: { '0-2': { count: 3, amount: '0.335' } } } } }),
    expected: {
      value: '3', status: 'OK',
      details: { count: '3', amountBrl: '0.34', oldestAgeDays: '0', statementAgeDays: '1', bands: [{ band: '0-2', count: '3', amountBrl: '0.34' }, { band: '3-7', count: '0', amountBrl: '0.00' }, { band: '8+', count: '0', amountBrl: '0.00' }] },
      dimensions: [{ key: 'valor_brl', value: '0.34' }, { key: 'mais_antiga_dias', value: '0' }, { key: 'faixa:0-2', value: '3' }, { key: 'faixa:3-7', value: '0' }, { key: 'faixa:8+', value: '0' }, { key: 'conta:c', value: '3' }],
    },
  },
];

module.exports = { id: 'fin.reconciliations_pending', version: 1, compute, testCases };
