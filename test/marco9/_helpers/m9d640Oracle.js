'use strict';

// Apoio da M9-D640: recalcula "do zero" só com as linhas-fonte (superusuário), sem read model, worker nem fórmula, os contratos ativos, a vacância e a inadimplência da locação.
// Datas pelo fuso de São Paulo (UTC-3 fixo) feitas na mão; dinheiro em decimal exato (money.js).
const money = require('../../../src/features/analytics/metrics/formulas/money');
const { addDays } = require('../../../src/features/analytics/metrics/period.dates');

const LEASE = ['LEASE', 'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL', 'PROPERTY_ADMIN'];
const spDate = (value) => new Date(new Date(value).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const q = async (env, sql, t, extra = {}) => (await env.admin.query(sql, { replacements: { c: t.companyId, lease: LEASE, ...extra } }))[0];
const sumOf = (list) => money.money(money.sum(list.map((r) => r.amount)));

async function activeFromSource(env, t) {
  const rows = await q(env, "SELECT total_value::text AS amount FROM legal.contracts WHERE company_id = :c AND deleted_at IS NULL AND contract_type IN (:lease) AND status = 'ACTIVE'", t);
  const suspended = await q(env, "SELECT count(*)::int AS n FROM legal.contracts WHERE company_id = :c AND deleted_at IS NULL AND contract_type IN (:lease) AND status = 'SUSPENDED'", t);
  return { count: rows.length, rent: sumOf(rows.map((r) => ({ amount: r.amount || '0' }))), withoutRent: rows.filter((r) => !r.amount || Number(r.amount) <= 0).length, suspended: suspended[0].n };
}

/** Locáveis: não excluído, publicação diferente de INACTIVE, situação AVAILABLE ou RENTED, com oferta de locação ou contrato ACTIVE/SUSPENDED e sem obra em andamento. */
async function vacancyFromSource(env, t) {
  const props = await q(env, "SELECT id::text AS id, availability_status AS status, publication_status AS publication FROM real_estate.properties WHERE company_id = :c AND deleted_at IS NULL", t);
  const offers = new Set((await q(env, "SELECT property_id::text AS p FROM real_estate.property_offers WHERE company_id = :c AND deleted_at IS NULL AND offer_type IN ('RENT', 'SEASONAL')", t)).map((r) => r.p));
  const leases = await q(env, "SELECT property_id::text AS p, status FROM legal.contracts WHERE company_id = :c AND deleted_at IS NULL AND contract_type IN (:lease) AND status IN ('ACTIVE', 'SUSPENDED')", t);
  const works = new Set((await q(env, "SELECT property_id::text AS p FROM construction.projects WHERE company_id = :c AND deleted_at IS NULL AND status IN ('ACTIVE', 'PAUSED', 'FINAL_INSPECTION')", t)).map((r) => r.p));
  const active = new Set(leases.filter((l) => l.status === 'ACTIVE').map((l) => l.p));
  const any = new Set(leases.map((l) => l.p));
  const rentable = props.filter((p) => p.publication !== 'INACTIVE' && ['AVAILABLE', 'RENTED'].includes(p.status) && (offers.has(p.id) || any.has(p.id)) && !works.has(p.id));
  const rented = rentable.filter((p) => active.has(p.id));
  const undefinedStatus = props.filter((p) => p.publication !== 'INACTIVE' && (!p.status || !['AVAILABLE', 'RENTED', 'SOLD', 'WITHDRAWN'].includes(p.status)) && (offers.has(p.id) || any.has(p.id))).length;
  const pct = rentable.length ? money.percent(rentable.length - rented.length, rentable.length).value : null;
  return { rentable: rentable.length, rented: rented.length, vacant: rentable.length - rented.length, undefinedStatus, pct };
}

/** Inadimplência de locação: entradas próprias de contrato de locação; janela [hoje - janela + 1, hoje]; vencido = PENDING com vencimento anterior a hoje. */
async function delinquencyFromSource(env, t, asOf, { windowDays = 90 } = {}) {
  const rows = await q(env, `SELECT e.status, e.amount::text AS amount, e.due_at, e.contract_id::text AS contract, (c.id IS NOT NULL) AS lease
    FROM finance.financial_entries e LEFT JOIN legal.contracts c ON c.id = e.contract_id AND c.deleted_at IS NULL AND c.contract_type IN (:lease)
    WHERE e.company_id = :c AND e.nature = 'RECEIVABLE' AND NOT e.is_third_party_funds AND e.reversal_of_entry_id IS NULL`, t);
  const start = addDays(asOf, -(windowDays - 1));
  const lateOf = (r) => r.status === 'PENDING' && r.due_at && spDate(r.due_at) < asOf;
  const mine = rows.filter((r) => r.lease);
  const overdue = mine.filter(lateOf);
  const inWindow = overdue.filter((r) => spDate(r.due_at) >= start);
  const billed = mine.filter((r) => !['REVERSED', 'CANCELLED'].includes(r.status) && r.due_at && spDate(r.due_at) >= start && spDate(r.due_at) <= asOf);
  const unlinked = rows.filter((r) => !r.lease).filter(lateOf);
  const rate = money.percent(sumOf(inWindow), sumOf(billed));
  return {
    overdue: sumOf(overdue), inWindow: sumOf(inWindow), outside: money.money(money.sub(sumOf(overdue), sumOf(inWindow))), billed: sumOf(billed), rate: rate.value, rateStatus: rate.status,
    count: overdue.length, unlinked: sumOf(unlinked), unlinkedCount: unlinked.length, withoutDueDate: mine.filter((r) => r.status === 'PENDING' && !r.due_at).length,
  };
}

/** Vencido próprio do Financeiro (toda entrada a receber PENDING vencida), para a consistência com a locação. */
async function financeOverdueFromSource(env, t, asOf) {
  const rows = await q(env, "SELECT amount::text AS amount, due_at FROM finance.financial_entries WHERE company_id = :c AND nature = 'RECEIVABLE' AND status = 'PENDING' AND NOT is_third_party_funds AND reversal_of_entry_id IS NULL AND due_at IS NOT NULL", t);
  return sumOf(rows.filter((r) => spDate(r.due_at) < asOf));
}

module.exports = { activeFromSource, vacancyFromSource, delinquencyFromSource, financeOverdueFromSource, spDate };
