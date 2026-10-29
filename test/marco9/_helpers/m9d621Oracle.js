'use strict';

// Apoio da M9-D621: recalcula as janelas de contas a pagar e recebíveis "do zero" só com as linhas do ledger (conexão de superusuário), sem o read
// model, o worker nem a fórmula. Data de vencimento pelo fuso de São Paulo (UTC-3 fixo) feita na mão; soma em decimal exato (money.js).
const money = require('../../../src/features/analytics/metrics/formulas/money');
const { addDays } = require('../../../src/features/analytics/metrics/period.dates');

const spDate = (value) => new Date(new Date(value).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);

async function windowFromSource(env, t, { nature, asOf, days }) {
  const [rows] = await env.admin.query(
    `SELECT amount::text AS amount, due_at FROM finance.financial_entries
      WHERE company_id = :c AND status = 'PENDING' AND nature = :nature AND NOT is_third_party_funds AND reversal_of_entry_id IS NULL AND due_at IS NOT NULL`,
    { replacements: { c: t.companyId, nature } }
  );
  const last = addDays(asOf, days - 1);
  const inside = rows.filter((r) => spDate(r.due_at) >= asOf && spDate(r.due_at) <= last);
  return { value: money.money(money.sum(inside.map((r) => r.amount))), count: inside.length };
}

const withoutDueDate = async (env, t, nature) => (await env.admin.query(
  "SELECT count(*)::int AS n FROM finance.financial_entries WHERE company_id = :c AND status = 'PENDING' AND nature = :nature AND NOT is_third_party_funds AND due_at IS NULL", { replacements: { c: t.companyId, nature } }
))[0][0].n;

module.exports = { windowFromSource, withoutDueDate, spDate };
