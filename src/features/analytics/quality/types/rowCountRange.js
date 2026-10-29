'use strict';

/**
 * M9-D696 (3.1 item 4) — ROW_COUNT_RANGE: (a) contagem de linhas do refresh dentro de [mínimo, máximo] calculados como média móvel dos últimos N
 * refreshes (padrão 14) do mesmo read model e empresa +- `faixa_contagem_pct` (padrão 50%); no rebuild a referência é a tabela atual e o
 * observado é a sombra; (b) queda para zero linhas quando a fonte tem dados é falha; (c) valores fora de faixa plausível (percentual > 100,
 * valor monetário negativo onde não pode) falham (`plausibleValues`). No rebuild só a queda abaixo da faixa reprova (DI-D696-11).
 */
const sql = require('../quality.sql');

const MODEL_RE = /^rm_[a-z][a-z0-9_]*$/;

async function previousAverage(ctx) {
  const rows = await sql.rows(ctx,
    `SELECT rows_upserted FROM analytics.read_model_refreshes
      WHERE company_id = :companyId AND read_model = :model AND status IN ('SUCCEEDED', 'DEGRADED') AND "trigger" <> 'REBUILD' AND id IS DISTINCT FROM CAST(:refreshId AS uuid)
      ORDER BY started_at DESC, created_at DESC LIMIT :window`,
    { model: ctx.readModel, refreshId: ctx.refreshId || null, window: ctx.params.window });
  if (!rows.length) return { average: null, samples: 0 };
  return { average: rows.reduce((acc, r) => acc + r.rows_upserted, 0) / rows.length, samples: rows.length };
}

async function liveRowCount(ctx) {
  if (!MODEL_RE.test(ctx.readModel)) throw new Error(`Read model inválido: ${ctx.readModel}`);
  return sql.count(ctx, `SELECT count(*)::int AS n FROM analytics."${ctx.readModel}" WHERE company_id = :companyId`);
}

function rowCountRange({ code, metrics = [], sourceCount }) {
  return {
    code, type: 'ROW_COUNT_RANGE', metrics,
    async run(ctx) {
      const rebuild = ctx.mode === 'REBUILD';
      const rows = rebuild ? await sql.count(ctx, `SELECT count(*)::int AS n FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId`) : ctx.rowsUpserted;
      const base = rebuild ? { average: await liveRowCount(ctx), samples: 1 } : await previousAverage(ctx);
      const pct = ctx.params.rangePct;
      const populated = rows === 0 ? (await sourceCount(ctx)) > 0 : false;
      const hasBand = base.average !== null && base.samples >= ctx.params.minRefreshes;
      const band = hasBand ? { min: Math.ceil((base.average * (100 - pct)) / 100), max: Math.floor((base.average * (100 + pct)) / 100) } : { min: null, max: null };
      const expected = { ...band, average: base.average, samples: base.samples, rangePct: pct };
      const observed = { rows, sourcePopulated: rows === 0 ? populated : null };
      if (rows === 0 && populated) return { passed: false, severityKey: 'ROW_COUNT_RANGE', expected, observed };
      // No rebuild só a QUEDA reprova: a reconstrução completa achar mais linhas que a tabela montada por eventos é a correção esperada (DI-D696-11).
      if (hasBand && (rows < band.min || (!rebuild && rows > band.max))) return { passed: false, severityKey: 'ROW_COUNT_RANGE', expected, observed };
      return { passed: true, expected, observed };
    },
  };
}

/** columns: [{ column, min?, max? }]; conta as linhas do read model fora dos limites (NULL também é fora). */
function plausibleValues({ code, metrics = [], columns }) {
  for (const c of columns) if (!/^[a-z_][a-z0-9_]*$/.test(c.column)) throw new Error(`Coluna inválida: ${c.column}`);
  return {
    code, type: 'ROW_COUNT_RANGE', metrics,
    async run(ctx) {
      const violations = [];
      for (const c of columns) {
        const conds = [`"${c.column}" IS NULL`];
        if (c.min !== undefined) conds.push(`"${c.column}" < ${Number(c.min)}`);
        if (c.max !== undefined) conds.push(`"${c.column}" > ${Number(c.max)}`);
        const n = await sql.count(ctx, `SELECT count(*)::int AS n FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId AND (${conds.join(' OR ')})`);
        if (n > 0) violations.push({ column: c.column, rows: n });
      }
      const expected = { columns: columns.map(({ column, min, max }) => ({ column, min: min ?? null, max: max ?? null })) };
      return violations.length ? { passed: false, severityKey: 'ROW_COUNT_RANGE', expected, observed: { violations } } : { passed: true, expected, observed: { violations: [] } };
    },
  };
}

module.exports = { rowCountRange, plausibleValues };
