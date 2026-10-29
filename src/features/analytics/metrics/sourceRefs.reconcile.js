'use strict';

/**
 * M9-D611 (3.2) — reconciliação do detalhe com o valor do KPI, no modo do tipo. SUM: a soma do campo monetário das linhas do filtro; COUNT:
 * o número de linhas; RECOMPUTE: a fórmula do KPI (M9-D605) refeita sobre as linhas, nas mesmas casas. Se não bate, o KPI é bloqueado no CI
 * (`assertReconciles` lança; o teste de cada família chama este arquivo). Roda como o sistema: não aplica permissão de detalhe.
 */
const AppError = require('../../../utils/AppError');
const money = require('./formulas/money');
const { getFormulaCatalog } = require('./formulaCatalog');
const { getSourceSpec } = require('./sourceRefs.spec');
const { verifyFilter } = require('./sourceRefs.filter');
const { countRows, sumValue, fetchRows } = require('./sourceRefs.query');
const { metricContext, modeOf } = require('./sourceRefs.build');
const { sourceSpecMissing } = require('./sourceRefs.errors');

const sameNumber = (a, b) => {
  try { return a != null && b != null && money.cmp(String(a), String(b)) === 0; } catch (_e) { return String(a) === String(b); }
};

async function detailValue(spec, mode, filter, { catalog, asOfDate }, transaction) {
  if (mode === 'COUNT') return String(await countRows(spec, filter, transaction));
  if (mode === 'SUM') return money.money(await sumValue(spec, filter, transaction));
  const formula = (catalog || getFormulaCatalog()).get(spec.formulaId);
  if (!formula) throw AppError.unprocessable('A fórmula informada não existe.', 'ANALYTICS_FORMULA_NOT_FOUND', { formulaId: spec.formulaId });
  return formula.compute(await fetchRows(spec, filter, transaction), { ...(spec.formulaParams || {}), asOfDate }).value;
}

/** { mode, ok, detail, kpi } de UMA referência (item de sourceRefs) contra o valor do KPI. A assinatura do filtro é conferida antes. */
async function reconcileDetail(ctx, metricCode, ref, kpiValue, options, transaction) {
  const spec = getSourceSpec(metricCode);
  if (!spec || spec.components) throw sourceSpecMissing(metricCode);
  const filter = await verifyFilter(ctx.companyId, spec.table, ref);
  const opts = options || {};
  const { unit } = await metricContext(metricCode, { unit: (opts.units || {})[metricCode] || opts.unit }, transaction);
  const mode = modeOf(spec, unit);
  const detail = await detailValue(spec, mode, filter, opts, transaction);
  return { mode, ok: sameNumber(detail, kpiValue), detail, kpi: String(kpiValue) };
}

async function assertReconciles(ctx, metricCode, ref, kpiValue, options, transaction) {
  const r = await reconcileDetail(ctx, metricCode, ref, kpiValue, options, transaction);
  if (!r.ok) throw AppError.internal('O detalhe não reconcilia com o valor do indicador.', 'ANALYTICS_RECONCILIATION_FAILED', { metricCode, ...r });
  return r;
}

module.exports = { reconcileDetail, assertReconciles };
