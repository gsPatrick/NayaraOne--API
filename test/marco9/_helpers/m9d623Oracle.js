'use strict';

// Apoio da M9-D623: recalcula os quatro KPIs "do zero" só com as linhas-fonte do Financeiro (superusuário), sem read model, worker nem fórmula.
// Datas pelo fuso de São Paulo (UTC-3 fixo) feitas na mão; dinheiro em decimal exato (money.js); dias úteis contados na mão (segunda a sexta).
const money = require('../../../src/features/analytics/metrics/formulas/money');

const spDate = (value) => new Date(new Date(value).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const dayMs = 86400000;
const calendarDays = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs);
function businessDays(from, to) {
  let n = 0;
  for (let t = Date.parse(`${from}T00:00:00Z`) + dayMs; t <= Date.parse(`${to}T00:00:00Z`); t += dayMs) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) n += 1;
  }
  return n;
}
const rows = async (env, sql, c) => (await env.admin.query(sql, { replacements: { c } }))[0];

async function marginFromSource(env, t, month) {
  const list = await rows(env, "SELECT nature, amount::text AS amount, result_center_id::text AS center FROM finance.financial_entries WHERE company_id = :c AND status = 'SETTLED' AND NOT is_third_party_funds AND reversal_of_entry_id IS NULL AND nature IN ('RECEIVABLE', 'PAYABLE') AND competence_month = '" + month + "'", t.companyId);
  const sectors = {};
  for (const r of list) {
    const k = r.center || 'sem_setor';
    sectors[k] = sectors[k] || { revenue: [], cost: [] };
    sectors[k][r.nature === 'RECEIVABLE' ? 'revenue' : 'cost'].push(r.amount);
  }
  const out = {};
  for (const [k, s] of Object.entries(sectors)) {
    const revenue = money.money(money.sum(s.revenue));
    const cost = money.money(money.sum(s.cost));
    const margin = money.money(money.sub(revenue, cost));
    out[k] = { revenue, cost, margin, pct: money.isZero(revenue) ? null : money.percent(margin, revenue).value };
  }
  const total = money.money(money.sum(Object.values(out).map((s) => s.margin)));
  return { sectors: out, total };
}

async function commissionsFromSource(env, t, asOf) {
  const month = asOf.slice(0, 7);
  const list = await rows(env, `SELECT i.status AS istatus, i.amount::text AS amount, i.paid_at, i.financial_entry_id::text AS entry, c.beneficiary_user_id::text AS broker, c.component, c.status AS cstatus, c.deleted_at,
      (SELECT count(*) FROM core.users u WHERE u.id = c.beneficiary_user_id AND u.deleted_at IS NULL AND u.status = 'ACTIVE')::int AS active
    FROM finance.commission_installments i JOIN finance.commissions c ON c.id = i.commission_id WHERE i.company_id = :c`, t.companyId);
  const provisioned = list.filter((r) => r.istatus === 'PENDING' && !r.deleted_at && ['PENDING', 'APPROVED'].includes(r.cstatus));
  const paid = list.filter((r) => r.istatus === 'PAID' && r.paid_at && spDate(r.paid_at).slice(0, 7) === month);
  const sum = (l) => money.money(money.sum(l.map((r) => r.amount)));
  const by = (l, key) => Object.fromEntries([...new Set(l.map((r) => r[key]))].map((k) => [k, sum(l.filter((r) => r[key] === k))]));
  return {
    provisioned: sum(provisioned), provisionedByBroker: by(provisioned.filter((r) => r.active), 'broker'), provisionedByComponent: by(provisioned, 'component'),
    withoutBroker: { count: provisioned.filter((r) => !r.active).length, amount: sum(provisioned.filter((r) => !r.active)) },
    paid: sum(paid), paidByBroker: by(paid.filter((r) => r.active), 'broker'), paidWithoutEntry: paid.filter((r) => !r.entry).length,
  };
}

async function repassesFromSource(env, t, asOf, { alertDays = 5 } = {}) {
  const list = (await rows(env, "SELECT net_amount::text AS amount, created_at, owner_person_id::text AS owner, property_id::text AS property FROM finance.owner_repasses WHERE company_id = :c AND status IN ('PENDING', 'APPROVED')", t.companyId))
    .map((r) => ({ ...r, date: spDate(r.created_at) }));
  const ages = list.map((r) => Math.max(0, calendarDays(r.date, asOf)));
  const overdue = list.filter((r) => businessDays(r.date, asOf) > alertDays);
  return {
    total: money.money(money.sum(list.map((r) => r.amount))), count: list.length,
    avgAge: list.length ? money.round(money.div(money.sum(ages), list.length), 2) : null,
    overdue: { count: overdue.length, amount: money.money(money.sum(overdue.map((r) => r.amount))) },
    byOwner: Object.fromEntries([...new Set(list.map((r) => r.owner))].map((o) => [o, money.money(money.sum(list.filter((r) => r.owner === o).map((r) => r.amount)))])),
  };
}

module.exports = { marginFromSource, commissionsFromSource, repassesFromSource, spDate, businessDays };
