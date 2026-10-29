'use strict';

/**
 * M9-D696 (3.1 item 5) — RECONCILIATION dos read models de domínio: para cada coluna numérica, a soma guardada (read model ou sombra do
 * rebuild) tem de bater com a soma recalculada da fonte para as mesmas chaves. Colunas de contagem exigem igualdade exata (tolerância 0);
 * colunas em reais usam `analytics.qualidade.tolerancia_conciliacao` (padrão R$ 0,01). Aritmética decimal exata. Nada guardado = nada a conferir.
 */
const money = require('../../metrics/formulas/money');
const { reconcileRows } = require('../recon/recon.source');

const dec = (v) => (v === null || v === undefined || v === '' ? '0' : String(v));
const total = (rows, column) => money.sum(rows.map((r) => dec(r.fields ? r.fields[column] : r[column])));

function modelReconciliation({ code, metrics = [] }) {
  return {
    code, type: 'RECONCILIATION', metrics,
    async run(ctx) {
      const data = await reconcileRows(ctx);
      if (!data) return { passed: true, expected: { keys: 0 }, observed: { keys: 0, table: ctx.table } };
      const expected = {}; const observed = {}; const failed = [];
      for (const col of data.columns) {
        if (data.source.length && !data.source.some((r) => r.fields[col.name] !== undefined)) continue; // coluna que a fonte não recalcula
        const places = col.count ? 0 : 2;
        const fromModel = money.round(total(data.stored, col.name), places);
        const fromSource = money.round(total(data.source, col.name), places);
        const diff = money.round(money.sub(fromSource, fromModel), places);
        const abs = diff.startsWith('-') ? diff.slice(1) : diff;
        const tolerance = col.count ? '0' : ctx.params.tolerance;
        expected[col.name] = { value: fromModel, tolerance: money.round(tolerance, places) };
        observed[col.name] = { value: fromSource, difference: abs };
        if (money.cmp(abs, tolerance) > 0) failed.push(col.name);
      }
      const exp = { columns: expected, keys: data.keys };
      const obs = { columns: observed, failedColumns: failed, table: ctx.table };
      return failed.length ? { passed: false, severityKey: 'RECONCILIATION', expected: exp, observed: obs } : { passed: true, expected: exp, observed: obs };
    },
  };
}

module.exports = { modelReconciliation };
