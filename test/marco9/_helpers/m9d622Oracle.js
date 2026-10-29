'use strict';

// Apoio da M9-D622: recalcula "do zero" só com as linhas do ledger e das parcelas de comissão (superusuário), sem read model, worker nem fórmula, o valor
// inadimplente, a taxa e a necessidade para respirar. Datas pelo fuso de São Paulo (UTC-3 fixo) feitas na mão; dinheiro em decimal exato (money.js).
const money = require('../../../src/features/analytics/metrics/formulas/money');
const { addDays } = require('../../../src/features/analytics/metrics/period.dates');

const spDate = (value) => new Date(new Date(value).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const calendarDays = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const ledgerRows = async (env, t) => (await env.admin.query(
  `SELECT nature, status, amount::text AS amount, due_at, settled_at, is_third_party_funds AS third, reversal_of_entry_id AS reversal, contract_id::text AS contract
     FROM finance.financial_entries WHERE company_id = :c`, { replacements: { c: t.companyId } }))[0];

const ownReceivables = (list) => list.filter((r) => r.nature === 'RECEIVABLE' && !r.third && r.reversal === null);
const sumOf = (list) => money.money(money.sum(list.map((r) => r.amount)));

/** Valor inadimplente, taxa, faixas e contratos na data-base, com a janela e as faixas informadas. */
async function delinquencyFromSource(env, t, asOf, { windowDays = 90, limits = [30, 60, 90] } = {}) {
  const own = ownReceivables(await ledgerRows(env, t));
  const overdue = own.filter((r) => r.status === 'PENDING' && r.due_at && spDate(r.due_at) < asOf);
  const windowStart = addDays(asOf, -(windowDays - 1));
  const inWindow = overdue.filter((r) => spDate(r.due_at) >= windowStart);
  const base = own.filter((r) => !['REVERSED', 'CANCELLED'].includes(r.status) && r.due_at && spDate(r.due_at) >= windowStart && spDate(r.due_at) <= asOf);
  const labels = [...limits.map((l, i) => `${i === 0 ? 1 : limits[i - 1] + 1}-${l}`), `${limits[limits.length - 1]}+`];
  const bands = Object.fromEntries(labels.map((l) => [l, []]));
  for (const r of overdue) bands[labels[(() => { const late = calendarDays(spDate(r.due_at), asOf); const i = limits.findIndex((l) => late <= l); return i === -1 ? limits.length : i; })()]].push(r);
  const contracts = {};
  for (const r of overdue) if (r.contract) (contracts[r.contract] = contracts[r.contract] || []).push(r);
  const total = sumOf(overdue);
  const rate = money.percent(sumOf(inWindow), sumOf(base));
  return {
    total, count: overdue.length, inWindow: sumOf(inWindow), outside: money.money(money.sub(total, sumOf(inWindow))), base: sumOf(base), rate: rate.value, rateStatus: rate.status,
    bands: Object.fromEntries(labels.map((l) => [l, sumOf(bands[l])])), contracts: Object.fromEntries(Object.entries(contracts).map(([k, v]) => [k, sumOf(v)])),
  };
}

/** Necessidade para respirar na data-base, a partir dos lançamentos e das parcelas de comissão. */
async function breathingFromSource(env, t, asOf) {
  const list = await ledgerRows(env, t);
  const own = list.filter((r) => !r.third && r.reversal === null);
  const horizon = addDays(asOf, 29);
  const pending = (nature) => own.filter((r) => r.nature === nature && r.status === 'PENDING' && r.due_at);
  const overduePayables = sumOf(pending('PAYABLE').filter((r) => spDate(r.due_at) < asOf));
  const payables30 = sumOf(pending('PAYABLE').filter((r) => spDate(r.due_at) >= asOf && spDate(r.due_at) <= horizon));
  const settled = own.filter((r) => r.status === 'SETTLED' && r.settled_at && spDate(r.settled_at) <= asOf);
  const freeCash = money.money(money.sub(sumOf(settled.filter((r) => r.nature === 'RECEIVABLE')), sumOf(settled.filter((r) => r.nature === 'PAYABLE'))));
  const [inst] = await env.admin.query(
    "SELECT amount::text AS amount, due_at FROM finance.commission_installments WHERE company_id = :c AND status = 'PENDING' AND financial_entry_id IS NULL", { replacements: { c: t.companyId } });
  const commissions = sumOf(inst.filter((r) => spDate(r.due_at) <= horizon));
  const gross = money.sub(money.sum([overduePayables, payables30, commissions]), freeCash);
  return { overduePayables, payables30, commissions, freeCash, gross: money.money(gross), need: money.cmp(gross, 0) > 0 ? money.money(gross) : '0.00' };
}

const withoutDueDate = async (env, t, nature) => (await env.admin.query(
  "SELECT count(*)::int AS n FROM finance.financial_entries WHERE company_id = :c AND status = 'PENDING' AND nature = :nature AND NOT is_third_party_funds AND due_at IS NULL", { replacements: { c: t.companyId, nature } }))[0][0].n;

module.exports = { delinquencyFromSource, breathingFromSource, withoutDueDate, spDate };
