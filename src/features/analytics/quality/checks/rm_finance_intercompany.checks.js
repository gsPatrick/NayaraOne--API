'use strict';

/**
 * M9-D625 (M9-D696 3.3) — checks do read model rm_finance_intercompany (transferências entre empresas, base da eliminação do consolidado). As
 * conferências leem o lado da ORIGEM do ledger (o lado do destino só se lê sob o contexto de RLS do destino, que o check não troca):
 *  - reconciliação: soma do valor do lado de origem nas linhas vivas do read model = soma dos lançamentos de saída vivos da fonte;
 *  - invariante: par MATCHED tem os dois lados com o valor da transferência; o estado dos outros pares bate com os lados (um lado ausente ou valor diferente);
 *  - completude: vencimento dos lançamentos de transferência (a eliminação de posição pendente depende dele).
 */
const { registerChecks } = require('../quality.catalog');
const sql = require('../quality.sql');
const t = require('../types');

const MODEL = 'rm_finance_intercompany';
const METRICS = ['fin.free_cash'];
const FROM_LEG = "idempotency_key LIKE 'intercompany-transfer:%:from'";

registerChecks(MODEL, [
  t.freshness({ code: 'intercompany_freshness', domain: 'FINANCE', metrics: METRICS }),
  t.reconciliation({
    code: 'intercompany_origin_leg_reconciliation', metrics: METRICS,
    expected: (ctx) => sql.value(ctx, `SELECT COALESCE(SUM(from_amount), 0)::text AS v FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId AND from_entry_status NOT IN ('CANCELLED', 'REVERSED')`),
    observed: (ctx) => sql.value(ctx, `SELECT COALESCE(SUM(amount), 0)::text AS v FROM finance.financial_entries
      WHERE company_id = :companyId AND ${FROM_LEG} AND status NOT IN ('CANCELLED', 'REVERSED')
        AND id IN (SELECT from_entry_id FROM finance.intercompany_transfers WHERE company_id = :companyId AND status IN ('PENDING', 'RECONCILED'))`),
  }),
  t.invariant({
    code: 'intercompany_pair_state_consistency', metrics: METRICS,
    async evaluate(ctx) {
      const n = await sql.count(ctx, `SELECT count(*)::int AS n FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId AND (
        (pair_state = 'MATCHED' AND NOT (from_amount = amount AND to_amount = amount AND from_entry_status NOT IN ('CANCELLED', 'REVERSED') AND to_entry_status NOT IN ('CANCELLED', 'REVERSED')))
        OR (pair_state = 'ONLY_FROM' AND to_entry_status IS NOT NULL AND to_entry_status NOT IN ('CANCELLED', 'REVERSED'))
        OR (pair_state = 'ONLY_TO' AND from_entry_status IS NOT NULL AND from_entry_status NOT IN ('CANCELLED', 'REVERSED'))
        OR (pair_state = 'AMOUNT_MISMATCH' AND from_amount = amount AND to_amount = amount))`);
      return { ok: n === 0, expected: { rule: 'o estado do par bate com os dois lados' }, observed: { rowsInconsistent: n } };
    },
  }),
  t.completeness({
    code: 'intercompany_due_date_completeness', field: 'due_at', metrics: METRICS,
    async measure(ctx) {
      const [row] = await sql.rows(ctx, `SELECT count(*)::int AS total, count(*) FILTER (WHERE due_at IS NULL)::int AS nulls FROM finance.financial_entries WHERE company_id = :companyId AND ${FROM_LEG}`);
      return row;
    },
  }),
  t.duplication({ code: 'intercompany_key_duplication', metrics: METRICS, measure: (ctx) => sql.duplicates(ctx, ['transfer_id']) }),
  t.duplication({ code: 'intercompany_applied_event_duplication', metrics: METRICS, measure: sql.duplicateAppliedEvents }),
]);
