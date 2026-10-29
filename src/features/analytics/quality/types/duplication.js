'use strict';

/**
 * M9-D696 (3.1 item 2) — DUPLICATION: chave de negócio repetida no read model ou evento aplicado duas vezes. Falha com 1 duplicata (BLOCK).
 * `measure(ctx)` devolve { duplicates, ... } (a contagem de linhas a mais); campos extras vão para `observed`.
 */
function duplication({ code, metrics = [], measure }) {
  return {
    code, type: 'DUPLICATION', metrics,
    async run(ctx) {
      const found = await measure(ctx);
      const expected = { duplicates: 0 };
      return found.duplicates === 0 ? { passed: true, expected, observed: found } : { passed: false, severityKey: 'DUPLICATION', expected, observed: found };
    },
  };
}

module.exports = { duplication };
