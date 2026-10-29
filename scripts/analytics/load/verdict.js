'use strict';

/**
 * M9-D699 (3.3) — critérios de aprovação do teste de carga, em função pura dos números:
 *   - p95 de cada operação do fluxo operacional (OLTP) com os painéis sob carga <= p95 da linha de base x (1 + limite/100);
 *   - p95 de cada painel <= a meta do painel (dashboard_definitions.p95_target_ms, M9-D698);
 *   - rebuild sob carga concluído, com o mesmo hash, sem erro;
 *   - nenhuma falha inesperada (5xx, tempo esgotado, erro de banco) nem no fluxo operacional nem nos painéis.
 * O limite de degradação é o parâmetro analytics.carga.degradacao_max_pct (padrão 10). Comparação exata em inteiros (microssegundos e
 * centésimos de ponto percentual), sem ponto flutuante na decisão.
 */
const micros = (ms) => Math.round(Number(ms) * 1000);

/** Variação percentual do p95 com 1 casa (texto), só para o relatório. Linha de base zero: null. */
function variationPct(baseMs, withBiMs) {
  const base = micros(baseMs);
  if (base <= 0) return null;
  return (Math.round(((micros(withBiMs) - base) * 1000) / base) / 10).toFixed(1);
}

function oltpResult(baseline, withBi, maxPct) {
  const out = {};
  for (const [op, base] of Object.entries(baseline)) {
    const bi = withBi[op];
    if (!bi || base.p95 === null || bi.p95 === null) {
      out[op] = { baselineP95: base.p95, withBiP95: bi ? bi.p95 : null, variationPct: null, pass: false, reason: 'sem amostra suficiente' };
      continue;
    }
    // bi <= base x (1 + max/100)  <=>  bi x 100 <= base x (100 + max)
    const pass = micros(bi.p95) * 100 <= micros(base.p95) * (100 + maxPct);
    out[op] = { baselineP95: base.p95, withBiP95: bi.p95, variationPct: variationPct(base.p95, bi.p95), pass, reason: pass ? null : `p95 ${bi.p95} ms contra ${base.p95} ms (limite ${maxPct}%)` };
  }
  return out;
}

function panelResult(panels, targets) {
  const out = {};
  for (const [code, s] of Object.entries(panels)) {
    const target = targets[code];
    const pass = target !== undefined && s.p95 !== null && micros(s.p95) <= micros(target);
    out[code] = { p95: s.p95, targetMs: target === undefined ? null : target, pass, reason: pass ? null : `p95 ${s.p95} ms contra a meta de ${target === undefined ? 'sem meta' : `${target} ms`}` };
  }
  return out;
}

/** O painel (ou consulta) que mais tempo de servidor consumiu: a pista do responsável quando a degradação reprova a etapa. */
function culprit(panels) {
  const ranked = Object.entries(panels).map(([code, s]) => ({ code, totalMs: (s.p50 || 0) * s.count })).sort((a, b) => b.totalMs - a.totalMs);
  return ranked.length ? { panel: ranked[0].code, totalMs: Math.round(ranked[0].totalMs) } : null;
}

/** input: { baseline, withBi, panels, targets, rebuild, maxPct, unexpected } -> { pass, oltp, panels, rebuild, failures[], culprit } */
function evaluate({ baseline, withBi, panels, targets, rebuild, maxPct, unexpected = 0 }) {
  const oltp = oltpResult(baseline, withBi, maxPct);
  const panelsOut = panelResult(panels, targets);
  const rebuildOut = {
    pass: Boolean(rebuild && rebuild.completed && rebuild.hashBefore === rebuild.hashAfter && !rebuild.error),
    reason: rebuild && rebuild.completed && rebuild.hashBefore === rebuild.hashAfter && !rebuild.error ? null
      : (rebuild && rebuild.error) || 'o rebuild não concluiu ou o hash mudou', ...(rebuild || {}),
  };
  const failures = [
    ...Object.entries(oltp).filter(([, r]) => !r.pass).map(([op, r]) => ({ kind: 'OLTP', name: op, reason: r.reason })),
    ...Object.entries(panelsOut).filter(([, r]) => !r.pass).map(([code, r]) => ({ kind: 'PAINEL', name: code, reason: r.reason })),
    ...(rebuildOut.pass ? [] : [{ kind: 'REBUILD', name: 'rm_finance_health', reason: rebuildOut.reason }]),
    ...(unexpected > 0 ? [{ kind: 'ERRO', name: 'falhas inesperadas', reason: `${unexpected} falha(s) inesperada(s) durante a carga` }] : []),
  ];
  return { pass: failures.length === 0, maxPct, oltp, panels: panelsOut, rebuild: rebuildOut, failures, culprit: failures.length ? culprit(panels) : null };
}

module.exports = { evaluate, variationPct, oltpResult, panelResult };
