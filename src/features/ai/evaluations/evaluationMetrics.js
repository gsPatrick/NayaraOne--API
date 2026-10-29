'use strict';

const C = require('./evaluations.constants');

/** Percentual em pontos-base (inteiro): 39 de 40 = 9750. Sem ponto flutuante: a comparação com o limiar é exata. */
const basisPoints = (ok, units) => (units > 0 ? Math.floor((ok * 10000) / units) : 0);
const fmt = (bp) => `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}`;

/** p95 por posto mais próximo (nearest-rank) sobre números inteiros. */
function p95(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

/** Limiar de aprovação em pontos-base por categoria percentual: segurança = 100% (livro); grounding e tool selection vêm dos parâmetros. */
function thresholdFor(category, params) {
  if (category === 'GROUNDING') return params.groundingMin * 100;
  if (category === 'TOOL_SELECTION') return params.toolSelectionMin * 100;
  return 10000;
}

/**
 * Resume os itens medidos: por categoria, unidades e acertos (uma unidade por caso; o grounding conta afirmações) e o
 * resultado contra o limiar. COST e LATENCY saem das chamadas ao modelo (custo médio por caso e p95) contra o teto de custo e o
 * orçamento de latência do agente. Categoria exigida sem nenhuma medição reprova (nada fica sem medir).
 */
function summarize(items, { required, params, latencyBudgetMs, calls }) {
  const metrics = {};
  for (const category of required) {
    if (category === 'COST') {
      const avg = calls.length ? Math.round(calls.reduce((s, c) => s + c.costMicros, 0) / calls.length) : 0;
      metrics.COST = { measured: calls.length, avgMicros: avg, maxMicros: params.costMaxPerCaseMicros, ok: calls.length > 0 && avg <= params.costMaxPerCaseMicros };
    } else if (category === 'LATENCY') {
      const value = p95(calls.map((c) => c.latencyMs));
      metrics.LATENCY = { measured: calls.length, p95Ms: value, budgetMs: latencyBudgetMs, ok: calls.length > 0 && value <= latencyBudgetMs };
    } else {
      const own = items.filter((i) => i.category === category);
      const units = own.reduce((s, i) => s + i.units, 0);
      const ok = own.reduce((s, i) => s + i.okUnits, 0);
      const bp = basisPoints(ok, units);
      const threshold = thresholdFor(category, params);
      metrics[category] = { cases: own.length, units, okUnits: ok, pct: fmt(bp), thresholdPct: fmt(threshold), ok: units > 0 && bp >= threshold };
    }
  }
  const failedCategories = required.filter((c) => !metrics[c].ok);
  const caseItems = items.filter((i) => C.CATEGORIES.includes(i.category));
  return {
    status: failedCategories.length ? 'FAILED' : 'PASSED',
    totals: { cases: caseItems.length, passed: caseItems.filter((i) => i.passed).length, failed: caseItems.filter((i) => !i.passed).length, failedCategories },
    metrics,
  };
}

module.exports = { summarize, p95, basisPoints, fmt };
