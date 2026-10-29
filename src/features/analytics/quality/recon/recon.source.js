'use strict';

/**
 * M9-D696 (3.1 item 5) — leitura para a conciliação dos read models de domínio: as linhas guardadas (tabela do read model ou a sombra do rebuild)
 * e as MESMAS chaves recalculadas direto da fonte pela consulta canônica do read model (`def.recompute`, sem filtro de evento), no mesmo
 * instante e sob a mesma RLS. Confere o guardado contra a fonte, pegando evento perdido, aplicação parcial ou linha adulterada.
 * Só as chaves mais recentemente atualizadas entram (`analytics.qualidade.max_chaves_conciliacao`); linha de data-base antiga
 * (`as_of_date` diferente de hoje) é fotografia histórica e fica de fora.
 */
const { getReadModel } = require('../../read-models/readModel.registry');
const clock = require('../../metrics/clock');
const sql = require('../quality.sql');

const NUMERIC_TYPES = new Set(['numeric', 'integer', 'bigint', 'smallint']);
const memo = new WeakMap(); // por execução dos checks (ctx.params é o mesmo objeto em todos os checks da execução)

/** Valor da chave em forma comparável (texto): data vira AAAA-MM-DD, uuid em minúsculas. */
function norm(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).toLowerCase();
}
const tupleOf = (row, columns) => JSON.stringify(columns.map((c) => norm(row[c])));
const q = (c) => `"${c}"`;

async function numericColumns(ctx, keyColumns) {
  const rows = await sql.rows(ctx, `SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :t ORDER BY ordinal_position`, { t: ctx.table });
  return rows.filter((r) => NUMERIC_TYPES.has(r.type) && r.name !== 'version' && !keyColumns.includes(r.name)).map((r) => ({ name: r.name, count: r.type !== 'numeric' }));
}

async function storedKeys(ctx, def, today) {
  const agg = def.aggregateColumns;
  const asOf = def.keyColumns.includes('as_of_date') ? ' AND as_of_date::text = :today' : '';
  if (!agg.length) {
    const n = await sql.count(ctx, `SELECT count(*)::int AS n FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId${asOf}`, { today });
    return n ? [{}] : [];
  }
  const cols = agg.map((c) => `${q(c)}::text AS ${q(c)}`).join(', ');
  return sql.rows(ctx, `SELECT ${cols} FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId${asOf} GROUP BY ${agg.map(q).join(', ')} ORDER BY max(refreshed_at) DESC LIMIT :n`, { today, n: ctx.params.maxReconcileKeys });
}

async function storedRows(ctx, def, keys, columns, today) {
  const agg = def.aggregateColumns;
  const asOf = def.keyColumns.includes('as_of_date') ? ' AND as_of_date::text = :today' : '';
  const select = [...def.keyColumns.map((c) => `${q(c)}::text AS ${q(c)}`), ...columns.map((c) => `${q(c.name)}::text AS ${q(c.name)}`)].join(', ');
  if (!agg.length) return sql.rows(ctx, `SELECT ${select} FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId${asOf}`, { today });
  const tuples = keys.map((k) => agg.map((c) => String(k[c])));
  return sql.rows(ctx, `SELECT ${select} FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId${asOf} AND (${agg.map((c) => `${q(c)}::text`).join(', ')}) IN (:tuples)`, { today, tuples });
}

/** Recalcula da fonte as chaves dadas; devolve as linhas por chave completa (sem repetir quando a consulta devolve a empresa inteira). */
async function recomputed(ctx, def, keys, today) {
  const out = new Map();
  for (const key of keys) {
    const result = await def.recompute({ ...ctx.scope, key, limit: null, asOfDate: today, now: clock.now(), event: null, transaction: ctx.transaction });
    const list = result && result.rows ? result.rows : [{ key: {}, fields: (result && result.fields) || {} }];
    for (const r of list) {
      const full = { ...key, ...r.key };
      out.set(tupleOf(full, def.keyColumns), { key: full, fields: r.fields || {} });
    }
  }
  return out;
}

/** { columns, stored: [linha], source: [linha], keys } ou null (nada guardado para conferir). */
async function reconcileRows(ctx) {
  const cached = memo.get(ctx.params);
  if (cached && cached.table === ctx.table) return cached.value;
  const def = getReadModel(ctx.readModel);
  if (!def) throw new Error(`Read model não registrado: ${ctx.readModel}`);
  const today = clock.businessToday();
  const keys = await storedKeys(ctx, def, today);
  let value = null;
  if (keys.length) {
    const columns = await numericColumns(ctx, def.keyColumns);
    const stored = await storedRows(ctx, def, keys, columns, today);
    const wanted = new Set(keys.map((k) => tupleOf(k, def.aggregateColumns)));
    const source = [...(await recomputed(ctx, def, keys, today)).values()].filter((r) => wanted.has(tupleOf(r.key, def.aggregateColumns)));
    value = { columns, stored, source, keys: keys.length };
  }
  memo.set(ctx.params, { table: ctx.table, value });
  return value;
}

/** Linha com algum número diferente de zero (agregado de empresa vazia devolve uma linha de zeros: não é fonte populada). */
const hasData = (fields) => Object.values(fields).some((v) => typeof v !== 'object' && v !== null && v !== '' && Number(v) !== 0 && !Number.isNaN(Number(v)));

/** Quantas linhas com dados a fonte tem hoje (para a regra "zero linhas com a fonte cheia"): recalcula as chaves da fonte (as mais novas, limitadas). */
async function sourceRowCount(ctx) {
  const def = getReadModel(ctx.readModel);
  const today = clock.businessToday();
  const keys = (await def.rebuild.keys({ ...ctx.scope, transaction: ctx.transaction })).slice(0, ctx.params.maxReconcileKeys);
  let rows = 0;
  for (const key of keys) {
    const result = await def.recompute({ ...ctx.scope, key, limit: null, asOfDate: today, now: clock.now(), event: null, transaction: ctx.transaction });
    const list = result && result.rows ? result.rows.map((r) => r.fields || {}) : [(result && result.fields) || {}];
    rows += list.filter(hasData).length;
  }
  return rows;
}

module.exports = { reconcileRows, sourceRowCount, numericColumns, norm };
