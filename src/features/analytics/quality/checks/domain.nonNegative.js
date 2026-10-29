'use strict';

/**
 * M9-D696 (3.1 item 4, "valores fora de faixa plausível") — nenhuma coluna numérica dos read models de domínio (contagens e valores em reais)
 * pode ser negativa; `signed` lista as exceções que podem (variação percentual, pontuação). Vazio (NULL) não é negativo: o que é nulo
 * é coberto pelo check de completude.
 */
const sql = require('../quality.sql');
const { numericColumns } = require('../recon/recon.source');

function nonNegative({ code, metrics = [], keyColumns, signed = [] }) {
  return {
    code, type: 'ROW_COUNT_RANGE', metrics,
    async run(ctx) {
      const columns = (await numericColumns(ctx, keyColumns)).map((c) => c.name).filter((c) => !signed.includes(c));
      const violations = [];
      for (const column of columns) {
        const n = await sql.count(ctx, `SELECT count(*)::int AS n FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId AND "${column}" < 0`);
        if (n > 0) violations.push({ column, rows: n });
      }
      const expected = { rule: 'contagens e valores >= 0', columns, signed };
      return violations.length ? { passed: false, severityKey: 'ROW_COUNT_RANGE', expected, observed: { violations } } : { passed: true, expected, observed: { violations: [] } };
    },
  };
}

module.exports = { nonNegative };
