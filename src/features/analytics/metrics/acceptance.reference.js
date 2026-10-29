'use strict';

/**
 * M9-D708 (3.3) — o valor do relatório de referência de um KPI. Duas fontes, nesta ordem:
 *  1. o ADAPTADOR do relatório de outra área (`referenceReports[código]`, injetado pelo comando em scripts/analytics/reconcile: o BI não importa serviço de
 *     outra área, BI-001), por exemplo o relatório de saúde financeira (getWeeklyHealthReport) para o caixa livre, as contas a pagar e a receber;
 *  2. a ORIGEM registrada do KPI (sourceRefs, M9-D611): o detalhe assinado do snapshot refeito direto das linhas da tabela de origem (soma, contagem ou a
 *     fórmula do KPI sobre as linhas), que é o relatório do módulo de origem (lista de contratos ATIVOS, de prazos, saldo de estoque...).
 * Devolve { value, label, comment }: `value` nulo quando não há como calcular (o motivo vai em `comment` e a linha fica PENDING sem diferença).
 */
const { getSourceSpec, reconcileDetail } = require('./sourceRefs');

/** O KPI tem de onde tirar o relatório? (adaptador ou origem de folha registrada) */
function hasReference(metricCode, referenceReports = {}) {
  if (typeof referenceReports[metricCode] === 'function') return true;
  const spec = getSourceSpec(metricCode);
  return Boolean(spec && !spec.components);
}

async function fromSource(ctx, metricCode, version, snapshot, { asOfDate }, transaction) {
  const spec = getSourceSpec(metricCode);
  const refs = snapshot && Array.isArray(snapshot.source_refs) ? snapshot.source_refs : [];
  if (!spec || spec.components || !refs.length) {
    return { value: null, label: spec ? `Origem registrada: ${spec.table || 'composta'}` : 'Sem origem registrada', comment: 'O snapshot não traz o rastreio da origem (sourceRefs) para refazer o relatório.' };
  }
  const biValue = snapshot.value_numeric != null ? String(snapshot.value_numeric) : '0';
  const r = await reconcileDetail(ctx, metricCode, refs[0], biValue, { asOfDate, units: { [metricCode]: version.unit } }, transaction);
  return { value: r.detail, label: `Origem ${spec.type} (${spec.table}): ${refs[0].description || spec.describe(refs[0].filter)}`, comment: null };
}

async function resolveReference(ctx, definition, version, snapshot, options, transaction) {
  const adapter = (options.referenceReports || {})[definition.metric_code];
  if (typeof adapter === 'function') {
    const out = await adapter({ ctx, asOfDate: options.asOfDate, now: options.now, version, snapshot, transaction });
    return { value: out.value === null || out.value === undefined ? null : String(out.value), label: out.label, comment: out.comment || null };
  }
  return fromSource(ctx, definition.metric_code, version, snapshot, options, transaction);
}

module.exports = { hasReference, resolveReference };
