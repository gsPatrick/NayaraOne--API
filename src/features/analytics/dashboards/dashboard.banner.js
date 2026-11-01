'use strict';

/**
 * M9-D634 (3.3) e M9-D697 — faixa de qualidade do painel: o PRIMEIRO widget, lista (antes dos números) os indicadores do painel que não estão
 * confiáveis: DEGRADED ou INCOMPLETE (dado incompleto), STALE (desatualizado), EXPIRED e nunca atualizado. Painel sem nenhum deles devolve a faixa
 * vazia e `visible: false`. O motivo vem pronto do servidor.
 */
const REASONS = Object.freeze({
  DEGRADED: 'Dado incompleto', INCOMPLETE: 'Dado incompleto', STALE: 'Dado desatualizado', EXPIRED: 'Dado antigo, não use para decidir', UNKNOWN: 'Ainda sem atualização',
});

function problemOf(view) {
  const { metric } = view;
  const state = metric.freshness && metric.freshness.state;
  if (state === 'EXPIRED' || state === 'UNKNOWN') return state;
  if (metric.status === 'DEGRADED' || metric.status === 'INCOMPLETE' || metric.incomplete) return metric.status === 'DEGRADED' ? 'DEGRADED' : 'INCOMPLETE';
  if (metric.status === 'STALE' || state === 'STALE') return 'STALE';
  return null;
}

/** views: widgets de indicador já compostos ({ title, metric }); blocks: widgets de bloco que adiaram a conclusão ({ title, block.reasons }). */
function buildQualityBanner(views, blocks = []) {
  const degradedMetrics = [];
  for (const view of views) {
    const problem = problemOf(view);
    if (problem) {
      const q = view.metric.quality || {};
      degradedMetrics.push({
        metricCode: view.metric.metricCode, title: view.title, problem, reason: REASONS[problem], status: view.metric.status,
        checks: (q.degradedBy || []).map((c) => c.checkCode), inheritedFrom: (q.inheritedFrom || []).map((c) => c.metricCode),
      });
    }
  }
  for (const b of blocks) { // métrica de que um bloco depende e que não é widget do painel também entra na faixa (uma vez)
    for (const r of b.block.reasons) {
      if (!degradedMetrics.some((d) => d.metricCode === r.metricCode)) degradedMetrics.push({ metricCode: r.metricCode, title: r.name || r.metricCode, problem: r.problem, reason: r.reason, status: null, checks: [], inheritedFrom: [] });
    }
  }
  const visible = degradedMetrics.length > 0;
  const summary = visible ? 'ATENCAO' : 'OK';
  const message = visible
    ? `${degradedMetrics.length} ${degradedMetrics.length === 1 ? 'indicador não está confiável' : 'indicadores não estão confiáveis'} neste painel. Confira antes de decidir.`
    : 'Todos os indicadores deste painel estão confiáveis.';
  return { banner: { summary, visible, message, degradedMetrics }, quality: { summary, degradedMetrics } };
}

module.exports = { buildQualityBanner };
