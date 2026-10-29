'use strict';

/**
 * M9-D696 (3.3) — declara o catálogo mínimo do livro de um read model de domínio (Comercial, Imóveis, Locação, Obras, Estoque, Jurídico,
 * Correspondente, Marketing, Atendimento) em poucas linhas:
 *   freshness (domínio) + reconciliação (guardado x fonte recalculada) + invariante do read model + completude do campo da fonte +
 *   duplicidade (chave de negócio e evento aplicado duas vezes) + faixa de linhas e valores não negativos.
 * `invariant` é o predicado SQL (sobre as colunas do read model) das linhas que VIOLAM a regra; `completeness` mede a fonte.
 */
const { registerChecks } = require('../quality.catalog');
const sql = require('../quality.sql');
const t = require('../types');
const { getReadModel } = require('../../read-models/readModel.registry');
const { modelReconciliation } = require('../types/modelReconciliation');
const { sourceRowCount } = require('../recon/recon.source');
const { nonNegative } = require('./domain.nonNegative');

function declareDomainChecks({ model, short, domain, metrics, completeness, invariant, signed = [] }) {
  const def = getReadModel(model);
  if (!def) throw new Error(`Checks: read model não registrado: ${model}`);
  const key = def.keyColumns;
  registerChecks(model, [
    t.freshness({ code: `${short}_freshness`, domain, metrics }),
    modelReconciliation({ code: `${short}_reconciliation`, metrics }),
    t.invariant({
      code: `${short}_invariant`, metrics,
      async evaluate(ctx) {
        const n = await sql.count(ctx, `SELECT count(*)::int AS n FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId AND (${invariant.violation})`);
        return { ok: n === 0, expected: { rule: invariant.rule }, observed: { rowsViolating: n } };
      },
    }),
    t.completeness({
      code: `${short}_${completeness.field}_completeness`, field: completeness.field, metrics,
      async measure(ctx) {
        const [row] = await sql.rows(ctx, completeness.sql);
        return { total: Number(row.total), nulls: Number(row.nulls) };
      },
    }),
    t.duplication({ code: `${short}_key_duplication`, metrics, measure: (ctx) => sql.duplicates(ctx, key) }),
    t.duplication({ code: `${short}_applied_event_duplication`, metrics, measure: sql.duplicateAppliedEvents }),
    t.rowCountRange({ code: `${short}_row_count`, metrics, sourceCount: sourceRowCount }),
    nonNegative({ code: `${short}_non_negative`, metrics, keyColumns: key, signed }),
  ]);
}

module.exports = { declareDomainChecks };
