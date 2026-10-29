'use strict';

/**
 * M9-D696 (3.1 item 5) — RECONCILIATION: total do read model = total da fonte recalculado por consulta INDEPENDENTE (a que o worker usa não
 * serve de conferência). `expected(ctx)` lê o read model e `observed(ctx)` lê a fonte; os dois devolvem texto decimal. Tolerância
 * `analytics.qualidade.tolerancia_conciliacao` (padrão R$ 0,01) para valores em reais; `kind: 'COUNT'` exige igualdade exata (tolerância 0).
 * Falha quando |read model - fonte| ULTRAPASSA a tolerância (aritmética decimal exata, nada de ponto flutuante).
 */
const money = require('../../metrics/formulas/money');

function reconciliation({ code, metrics = [], kind = 'MONEY', expected, observed }) {
  return {
    code, type: 'RECONCILIATION', metrics,
    async run(ctx) {
      const fromModel = await expected(ctx);
      const fromSource = await observed(ctx);
      const tolerance = kind === 'COUNT' ? '0' : ctx.params.tolerance;
      const places = kind === 'COUNT' ? 0 : 2;
      const diff = money.round(money.sub(fromSource ?? '0', fromModel ?? '0'), places);
      const abs = diff.startsWith('-') ? diff.slice(1) : diff;
      const exp = { value: money.round(fromModel ?? '0', places), tolerance: money.round(tolerance, places), table: ctx.table };
      const obs = { value: money.round(fromSource ?? '0', places), difference: abs, table: ctx.table };
      return money.cmp(abs, tolerance) > 0 ? { passed: false, severityKey: 'RECONCILIATION', expected: exp, observed: obs } : { passed: true, expected: exp, observed: obs };
    },
  };
}

module.exports = { reconciliation };
