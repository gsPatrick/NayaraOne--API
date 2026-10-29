'use strict';

/**
 * M9-D697 (3.4 e 3.5) — o que depende de uma lista de métricas e não pode concluir sobre dado ruim:
 *  - `evaluateBlock`: bloco do Centro de Comando (M9-D685) e área do resumo da NAY (M9-D693) olham as métricas de que dependem; com alguma
 *    DEGRADED (inclusive por EXPIRED), INCOMPLETE (inclusive sem registro) ou STALE, o bloco adia a conclusão: "Conclusão adiada: dado incompleto";
 *  - `qualityAttentionItem`: o item ATENCAO_QUALIDADE da NAY no lugar da conclusão sobre aquela área (sem número da métrica ruim);
 *  - `assertMetricExportable`: exportação de métrica DEGRADED é recusada sempre, sem parâmetro que libere (409 ANALYTICS_EXPORT_DEGRADED_BLOCKED).
 */
const AppError = require('../../../utils/AppError');

const DEFERRED_TEXT = 'Conclusão adiada: dado incompleto';
const MISSING = new Set(['ANALYTICS_SNAPSHOT_NOT_AVAILABLE', 'ANALYTICS_METRIC_NOT_FOUND']);
const REASON_TEXT = Object.freeze({
  DEGRADED: 'Dado incompleto', INCOMPLETE: 'Dado incompleto', STALE: 'Dado desatualizado', EXPIRED: 'Dado antigo, não use para decidir', UNKNOWN: 'Ainda sem atualização',
});

const readOf = (ctx) => ({ companyId: ctx.companyId, groupId: ctx.groupId, permissions: ctx.permissions || [] });

/** Estado de uma métrica para a conclusão: { metricCode, status, problem, freshnessState } (problem nulo = confiável). */
async function metricProblem(ctx, metricCode, asOfDate, transaction) {
  const { readMetricAsOfUnchecked } = require('../metrics/registry.asOf'); // tardio: o registro apresenta o snapshot pela camada de qualidade
  let read;
  try {
    read = await readMetricAsOfUnchecked(readOf(ctx), { metricCode, scopeType: 'COMPANY', scopeId: ctx.companyId, asOfDate }, transaction);
  } catch (err) {
    if (MISSING.has(err.code)) return { metricCode, status: 'INCOMPLETE', problem: 'INCOMPLETE', reason: REASON_TEXT.INCOMPLETE };
    throw err;
  }
  const state = read.freshness && read.freshness.state;
  let problem = null;
  if (state === 'EXPIRED' || state === 'UNKNOWN') problem = state;
  else if (read.status === 'DEGRADED' || read.status === 'INCOMPLETE') problem = read.status;
  else if (read.status === 'STALE' || state === 'STALE') problem = 'STALE';
  return { metricCode, status: read.status, problem, reason: problem ? REASON_TEXT[problem] : null };
}

/** { deferred, concludes, text, reasons: [{ metricCode, problem, reason }] } para as métricas de que o bloco depende. */
async function evaluateBlock(ctx, metricCodes, asOfDate, transaction) {
  const reasons = [];
  for (const code of [...new Set(metricCodes || [])]) {
    const m = await metricProblem(ctx, code, asOfDate, transaction);
    if (m.problem) reasons.push({ metricCode: code, problem: m.problem, reason: m.reason });
  }
  const deferred = reasons.length > 0;
  return { deferred, concludes: !deferred, text: deferred ? DEFERRED_TEXT : null, reasons };
}

/** Item ATENCAO_QUALIDADE da NAY para uma área cujo bloco adiou a conclusão; nulo quando a área concluiu. Nunca leva o valor da métrica. */
function qualityAttentionItem({ area, gate }) {
  if (!gate || gate.concludes) return null;
  const codes = gate.reasons.map((r) => r.metricCode);
  return {
    tipo: 'ATENCAO_QUALIDADE', area, metricCodes: codes,
    fato: `${area}: dado incompleto em ${codes.length === 1 ? 'um indicador' : `${codes.length} indicadores`}; a conclusão sobre esta área fica adiada até a próxima atualização.`,
  };
}

/** Recusa a exportação de métrica DEGRADED (inclui a que ficou EXPIRED). INCOMPLETE não tem valor para sair e não é o caso da regra. */
async function assertMetricExportable(ctx, metricCode, asOfDate, transaction) {
  const { readMetricAsOfUnchecked } = require('../metrics/registry.asOf');
  const read = await readMetricAsOfUnchecked(readOf(ctx), { metricCode, scopeType: 'COMPANY', scopeId: ctx.companyId, asOfDate }, transaction);
  if (read.status === 'DEGRADED') {
    throw AppError.conflict('O indicador está com dado incompleto e não pode ser exportado agora.', 'ANALYTICS_EXPORT_DEGRADED_BLOCKED', { metricCode });
  }
  return read;
}

module.exports = { evaluateBlock, qualityAttentionItem, assertMetricExportable, DEFERRED_TEXT };
