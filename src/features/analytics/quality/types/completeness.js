'use strict';

/**
 * M9-D696 (3.1 item 1) — COMPLETENESS: proporção de nulos num campo essencial da fonte. Falha acima de `max_nulos_pct.<campo>` (padrão 1%, 0%
 * para o campo usado direto numa fórmula); é WARN até `max_nulos_bloqueio_pct` (padrão 5%) e BLOCK acima disso.
 * `measure(ctx)` devolve { total, nulls }; sem linhas (total 0) não há o que medir e o check passa.
 * DI-BI2-2: a verificação com `analytics.qualidade.completude_bloqueia.<código>` desligado nunca passa de WARN (`expected.blocks` mostra isso).
 */
const { completenessBlocks } = require('../quality.checkSeverity');

function completeness({ code, field, metrics = [], measure }) {
  return {
    code, type: 'COMPLETENESS', field, metrics,
    async run(ctx) {
      const { total, nulls } = await measure(ctx);
      const limit = ctx.params.nullPct[field];
      const blockLimit = ctx.params.blockNullPct;
      const pct = total === 0 ? 0 : Math.round((nulls * 10000) / total) / 100; // 2 casas, contagem inteira (nenhum valor monetário)
      const blocks = completenessBlocks(ctx.params.completenessBlocks, code);
      const expected = { field, maxNullPct: limit, blockAbovePct: blockLimit, blocks };
      const observed = { total, nulls, pct };
      if (pct <= limit) return { passed: true, expected, observed };
      return { passed: false, severityKey: pct > blockLimit && blocks ? 'COMPLETENESS_BLOCK' : 'COMPLETENESS', expected, observed };
    },
  };
}

module.exports = { completeness };
