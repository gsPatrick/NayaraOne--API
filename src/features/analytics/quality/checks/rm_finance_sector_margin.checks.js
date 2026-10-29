'use strict';

/** M9-D696 (3.3) — checks do read model rm_finance_sector_margin (receita e custo realizados por setor e mês de competência). */
const { registerChecks } = require('../quality.catalog');
const sql = require('../quality.sql');
const t = require('../types');

const MODEL = 'rm_finance_sector_margin';
const NO_CENTER = '00000000-0000-0000-0000-000000000000';
const OWN_LIVE = 'NOT is_third_party_funds AND reversal_of_entry_id IS NULL';

function totalReconciliation(code, nature, column, metric) {
  return t.reconciliation({
    code, metrics: [metric],
    expected: (ctx) => sql.value(ctx, `SELECT COALESCE(SUM("${column}"), 0)::text AS v FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId`),
    // Fonte: o que o ledger liquidou, só nos setores e meses que o read model já projetou (um par ainda não projetado não é divergência).
    observed: (ctx) => sql.value(ctx, `SELECT COALESCE(SUM(fe.amount), 0)::text AS v FROM finance.financial_entries fe
      WHERE fe.company_id = :companyId AND fe.status = 'SETTLED' AND fe.nature = '${nature}' AND NOT fe.is_third_party_funds AND fe.reversal_of_entry_id IS NULL
        AND EXISTS (SELECT 1 FROM ${sql.tableOf(ctx)} m WHERE m.company_id = fe.company_id AND m.competence_month = fe.competence_month
          AND m.result_center_id::text = COALESCE(fe.result_center_id, CAST(:nil AS uuid))::text)`, { nil: NO_CENTER }),
  });
}

const nullShare = (column) => async (ctx) => {
  const [row] = await sql.rows(ctx, `SELECT count(*)::int AS total, count(*) FILTER (WHERE ${column} IS NULL)::int AS nulls FROM finance.financial_entries
    WHERE company_id = :companyId AND status = 'SETTLED' AND nature IN ('RECEIVABLE', 'PAYABLE') AND ${OWN_LIVE}`);
  return row;
};

registerChecks(MODEL, [
  t.freshness({ code: 'sector_margin_freshness', domain: 'FINANCE', metrics: ['fin.sector_margin'] }),
  totalReconciliation('sector_margin_revenue_reconciliation', 'RECEIVABLE', 'revenue_actual', 'fin.sector_margin'),
  totalReconciliation('sector_margin_cost_reconciliation', 'PAYABLE', 'cost_actual', 'fin.sector_margin'),
  t.invariant({
    code: 'sector_margin_non_negative', metrics: ['fin.sector_margin'],
    async evaluate(ctx) {
      const n = await sql.count(ctx, `SELECT count(*)::int AS n FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId AND (revenue_actual < 0 OR cost_actual < 0)`);
      return { ok: n === 0, expected: { rule: 'receita e custo realizados >= 0' }, observed: { rowsNegative: n } };
    },
  }),
  t.completeness({ code: 'sector_margin_center_completeness', field: 'result_center_id', metrics: ['fin.sector_margin'], measure: nullShare('result_center_id') }),
  t.completeness({ code: 'sector_margin_competence_completeness', field: 'competence_month', metrics: ['fin.sector_margin'], measure: nullShare('competence_month') }),
  t.duplication({ code: 'sector_margin_key_duplication', metrics: ['fin.sector_margin'], measure: (ctx) => sql.duplicates(ctx, ['result_center_id', 'competence_month']) }),
  t.duplication({ code: 'sector_margin_applied_event_duplication', metrics: ['fin.sector_margin'], measure: sql.duplicateAppliedEvents }),
  t.rowCountRange({ code: 'sector_margin_row_count', metrics: ['fin.sector_margin'], sourceCount: (ctx) => sql.count(ctx, "SELECT count(*)::int AS n FROM finance.financial_entries WHERE company_id = :companyId AND status = 'SETTLED'") }),
  t.plausibleValues({ code: 'sector_margin_plausible_values', metrics: ['fin.sector_margin'], columns: [{ column: 'revenue_actual', min: 0 }, { column: 'cost_actual', min: 0 }] }),
]);
