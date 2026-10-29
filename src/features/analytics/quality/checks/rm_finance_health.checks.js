'use strict';

/**
 * M9-D696 (3.3) — checks do read model rm_finance_health. As conferências leem o ledger por consulta própria (formulação diferente da do
 * worker, que usa FILTER; aqui CASE e janela por data-base) para que um erro de fórmula do read model apareça como divergência.
 */
const { registerChecks } = require('../quality.catalog');
const sql = require('../quality.sql');
const t = require('../types');
const { latestRow, boundsOf } = require('./finance.shared');

const MODEL = 'rm_finance_health';
const OWN_LIVE = 'NOT is_third_party_funds AND reversal_of_entry_id IS NULL';

async function ledgerValue(ctx, asOf, where) {
  return sql.value(ctx, `SELECT COALESCE(SUM(CASE WHEN nature = 'RECEIVABLE' THEN amount ELSE -amount END), 0)::text AS v FROM finance.financial_entries WHERE company_id = :companyId AND ${where}`,
    { dayEnd: boundsOf(asOf).dayEnd.toISOString() });
}

/**
 * M9-D620: o que o caixa livre soma além do ledger de receber e pagar — o saldo de abertura das contas (quando o read model o usou, o que fica guardado nos
 * critérios da própria linha) e as transferências entre empresas liquidadas (sai de uma conta, entra em outra). Texto decimal.
 */
async function cashAdjustments(ctx, row, withOpening = true) {
  const criteria = JSON.parse((await latestRow(ctx, ['source_criteria']))?.source_criteria || '{}');
  const useOpening = withOpening && (((criteria['fin.free_cash'] || {}).equals || {}).includeOpening !== false);
  const opening = useOpening ? await sql.value(ctx, 'SELECT COALESCE(SUM(opening_balance), 0)::text AS v FROM finance.bank_accounts WHERE company_id = :companyId AND deleted_at IS NULL AND owner_person_id IS NULL') : '0';
  const legs = await sql.value(ctx, `SELECT COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS v FROM finance.financial_entries
     WHERE company_id = :companyId AND status = 'SETTLED' AND nature = 'ADJUSTMENT' AND idempotency_key LIKE 'intercompany-transfer:%' AND reversal_of_entry_id IS NULL AND settled_at < :dayEnd`,
  { dayEnd: boundsOf(row.as_of_date).dayEnd.toISOString() });
  return sql.value(ctx, 'SELECT (CAST(:a AS numeric) + CAST(:b AS numeric))::text AS v', { a: opening, b: legs });
}

function cashReconciliation() {
  return t.reconciliation({
    code: 'finance_health_free_cash_reconciliation', metrics: ['fin.free_cash'],
    expected: async (ctx) => (await latestRow(ctx, ['free_cash']))?.free_cash,
    observed: async (ctx) => {
      const row = await latestRow(ctx, ['free_cash']);
      if (!row) return null;
      const own = await ledgerValue(ctx, row.as_of_date, `status = 'SETTLED' AND ${OWN_LIVE} AND nature IN ('RECEIVABLE', 'PAYABLE') AND settled_at < :dayEnd`);
      return sql.value(ctx, 'SELECT (CAST(:a AS numeric) + CAST(:b AS numeric))::text AS v', { a: own, b: await cashAdjustments(ctx, row) });
    },
  });
}

function horizonReconciliation(code, nature, column, metric) {
  return t.reconciliation({
    code, metrics: [metric],
    expected: async (ctx) => (await latestRow(ctx, [column]))?.[column],
    observed: async (ctx) => {
      const row = await latestRow(ctx, [column]);
      if (!row) return null;
      const b = boundsOf(row.as_of_date);
      return sql.value(ctx, `SELECT COALESCE(SUM(amount), 0)::text AS v FROM finance.financial_entries WHERE company_id = :companyId AND status = 'PENDING' AND nature = '${nature}' AND ${OWN_LIVE}
        AND due_at >= :from AND due_at < :to`, { from: b.today.toISOString(), to: b.horizon30.toISOString() });
    },
  });
}

function horizonOrder(code, prefix, metrics) {
  return t.invariant({
    code, metrics,
    async evaluate(ctx) {
      const cols = [`${prefix}_7d`, `${prefix}_30d`, `${prefix}_60d`];
      const row = await latestRow(ctx, cols);
      const expected = { rule: `${cols[0]} <= ${cols[1]} <= ${cols[2]}` };
      if (!row) return { ok: true, expected, observed: {} };
      const n = cols.map((c) => Number(row[c]));
      return { ok: n[0] <= n[1] && n[1] <= n[2], expected, observed: Object.fromEntries(cols.map((c) => [c, row[c]])) };
    },
  });
}

const cashSplit = t.consistency({
  code: 'finance_health_cash_split_consistency', metrics: ['fin.free_cash', 'fin.third_party_cash'],
  async evaluate(ctx) {
    const row = await latestRow(ctx, ['free_cash', 'third_party_cash']);
    if (!row) return { ok: true, expected: { rule: 'caixa livre + terceiros = caixa total' }, observed: {} };
    const ledgerTotal = await ledgerValue(ctx, row.as_of_date, `status = 'SETTLED' AND reversal_of_entry_id IS NULL AND nature IN ('RECEIVABLE', 'PAYABLE') AND settled_at < :dayEnd`);
    const total = await sql.value(ctx, 'SELECT (CAST(:a AS numeric) + CAST(:b AS numeric))::text AS v', { a: ledgerTotal, b: await cashAdjustments(ctx, row) }); // M9-D620: caixa total = ledger + abertura + transferências
    const [{ sum }] = await sql.rows(ctx, 'SELECT (CAST(:free AS numeric) + CAST(:third AS numeric))::text AS sum', { free: row.free_cash, third: row.third_party_cash });
    const [{ equal }] = await sql.rows(ctx, 'SELECT CAST(:a AS numeric) = CAST(:b AS numeric) AS equal', { a: sum, b: total });
    return { ok: equal, expected: { rule: 'caixa livre + terceiros = caixa total', total }, observed: { freeCash: row.free_cash, thirdPartyCash: row.third_party_cash, sum } };
  },
});

const MONEY_COLUMNS = ['payables_7d', 'payables_30d', 'payables_60d', 'receivables_7d', 'receivables_30d', 'receivables_60d', 'overdue_payables', 'overdue_amount', 'receivables_base_90d'];

registerChecks(MODEL, [
  t.freshness({ code: 'finance_health_freshness', domain: 'FINANCE', metrics: ['fin.free_cash', 'fin.overdue_receivables'] }),
  cashReconciliation(),
  horizonReconciliation('finance_health_receivables_30d_reconciliation', 'RECEIVABLE', 'receivables_30d', 'fin.receivables_30d'),
  horizonReconciliation('finance_health_payables_30d_reconciliation', 'PAYABLE', 'payables_30d', 'fin.payables_30d'),
  horizonOrder('finance_health_receivables_horizon_order', 'receivables', ['fin.receivables_7d', 'fin.receivables_30d']),
  horizonOrder('finance_health_payables_horizon_order', 'payables', ['fin.payables_7d', 'fin.payables_30d']),
  cashSplit,
  t.completeness({
    code: 'finance_health_due_date_completeness', field: 'due_at', metrics: ['fin.payables_30d', 'fin.receivables_30d'],
    async measure(ctx) {
      const [row] = await sql.rows(ctx, `SELECT count(*)::int AS total, count(*) FILTER (WHERE due_at IS NULL)::int AS nulls FROM finance.financial_entries
        WHERE company_id = :companyId AND status = 'PENDING' AND nature IN ('PAYABLE', 'RECEIVABLE') AND ${OWN_LIVE}`);
      return row;
    },
  }),
  t.duplication({ code: 'finance_health_key_duplication', metrics: ['fin.free_cash'], measure: (ctx) => sql.duplicates(ctx, ['as_of_date']) }),
  t.duplication({ code: 'finance_health_applied_event_duplication', metrics: ['fin.free_cash'], measure: sql.duplicateAppliedEvents }),
  t.rowCountRange({ code: 'finance_health_row_count', metrics: ['fin.free_cash'], sourceCount: (ctx) => sql.count(ctx, 'SELECT count(*)::int AS n FROM finance.financial_entries WHERE company_id = :companyId') }),
  t.plausibleValues({ code: 'finance_health_plausible_values', metrics: ['fin.free_cash'], columns: MONEY_COLUMNS.map((column) => ({ column, min: 0 })) }),
]);
