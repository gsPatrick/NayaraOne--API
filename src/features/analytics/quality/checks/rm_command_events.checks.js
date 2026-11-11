'use strict';

/**
 * M9-D710 (3.3) — checks do read model rm_command_events: frescor, conciliação com a fonte, invariante (a compensatória nega a original e a original conta +1), completude de `occurred_at`
 * dos fatos (contrato assinado sem data de assinatura, oportunidade ganha sem fechamento, liquidação sem settledAt), duplicidade, valores não negativos e faixa de linhas. `amount` e
 * `count_effect` podem ser negativos de propósito (linha compensatória): ficam fora da regra de não negativo. A faixa de linhas por média móvel dos refreshes NÃO se aplica a este read model
 * (DI-D710-6): o tamanho de um refresh é 1 registro quando vem de evento e a janela inteira quando vem da agenda, então a média oscilaria e rebaixaria os KPIs sem erro real; vale a regra
 * "a tabela não pode ficar vazia com a fonte cheia", medida sobre a tabela inteira (também no rebuild, sobre a sombra).
 */
const { registerChecks } = require('../quality.catalog');
const sql = require('../quality.sql');
const t = require('../types');
const { modelReconciliation } = require('../types/modelReconciliation');
const { sourceRowCount } = require('../recon/recon.source');
const { nonNegative } = require('./domain.nonNegative');

const MODEL = 'rm_command_events';
const METRICS = ['legal.contracts_signed', 'crm.opportunities_won', 'fin.payments_settled_relevant'];
const KEY = ['kind', 'source_id', 'revision'];
const SIGNED = "'SIGNED', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'CLOSED'";
const COMPLETENESS = `SELECT (c.total + o.total + p.total)::int AS total, (c.nulls + o.nulls + p.nulls)::int AS nulls FROM
  (SELECT count(*) AS total, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM legal.signatures s JOIN legal.contract_versions v ON v.id = s.contract_version_id AND v.company_id = s.company_id
      WHERE v.contract_id = k.id AND s.company_id = k.company_id AND s.status = 'SIGNED' AND s.signed_at IS NOT NULL)) AS nulls
     FROM legal.contracts k WHERE k.company_id = :companyId AND k.deleted_at IS NULL AND k.status IN (${SIGNED})) c,
  (SELECT count(*) AS total, count(*) FILTER (WHERE closed_at IS NULL) AS nulls FROM crm.opportunities WHERE company_id = :companyId AND deleted_at IS NULL AND stage = 'WON') o,
  (SELECT count(*) AS total, count(*) FILTER (WHERE settled_at IS NULL) AS nulls FROM finance.financial_entries
     WHERE company_id = :companyId AND entry_type = 'DEBIT' AND nature = 'PAYABLE' AND reversal_of_entry_id IS NULL AND status = 'SETTLED') p`;
const INVARIANT = '(is_reversal AND (count_effect <> -1 OR COALESCE(amount, 0) > 0)) OR (NOT is_reversal AND count_effect <> 1)';

/** Tabela vazia com a fonte cheia reprova; qualquer outro tamanho passa. */
const notEmptyWithSource = {
  code: 'command_events_row_count', type: 'ROW_COUNT_RANGE', metrics: METRICS,
  async run(ctx) {
    const rows = await sql.count(ctx, `SELECT count(*)::int AS n FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId`);
    const expected = { rule: 'a tabela não fica vazia quando a fonte tem fatos' };
    if (rows > 0) return { passed: true, expected, observed: { rows } };
    const populated = (await sourceRowCount(ctx)) > 0;
    return populated ? { passed: false, severityKey: 'ROW_COUNT_RANGE', expected, observed: { rows, sourcePopulated: true } } : { passed: true, expected, observed: { rows, sourcePopulated: false } };
  },
};

registerChecks(MODEL, [
  t.freshness({ code: 'command_events_freshness', domain: 'FINANCE', metrics: METRICS }),
  modelReconciliation({ code: 'command_events_reconciliation', metrics: METRICS }),
  t.invariant({
    code: 'command_events_invariant', metrics: METRICS,
    async evaluate(ctx) {
      const n = await sql.count(ctx, `SELECT count(*)::int AS n FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId AND (${INVARIANT})`);
      return { ok: n === 0, expected: { rule: 'a compensatória (revision 1) tem count_effect -1 e valor não positivo; a original (revision 0) tem count_effect 1' }, observed: { rowsViolating: n } };
    },
  }),
  t.completeness({
    code: 'command_events_occurred_at_completeness', field: 'occurred_at', metrics: METRICS,
    async measure(ctx) {
      const [row] = await sql.rows(ctx, COMPLETENESS);
      return { total: Number(row.total), nulls: Number(row.nulls) };
    },
  }),
  t.duplication({ code: 'command_events_key_duplication', metrics: METRICS, measure: (ctx) => sql.duplicates(ctx, KEY) }),
  t.duplication({ code: 'command_events_applied_event_duplication', metrics: METRICS, measure: sql.duplicateAppliedEvents }),
  notEmptyWithSource,
  nonNegative({ code: 'command_events_non_negative', metrics: METRICS, keyColumns: KEY, signed: ['amount', 'count_effect'] }),
]);
