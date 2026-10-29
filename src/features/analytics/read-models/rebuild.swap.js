'use strict';

/**
 * M9-D608 (3.2 passo 5) — troca atômica numa transação. Trava a tabela atual (SHARE ROW EXCLUSIVE: o worker espera, a leitura segue),
 * troca as linhas da empresa pelas da sombra, PRESERVA rm_applied_events, e recalcula os agregados tocados por eventos que o worker
 * aplicou durante a reconstrução (linhas de rm_applied_events que a fotografia do rebuild não enxergava). Agregados adiados
 * (rm_stale_aggregates) marcados até a fotografia saem, porque a sombra os recalculou sem teto de linhas.
 */
const { sequelize } = require('../../../models');
const { upsertAggregate, aggregateColumnsOf } = require('./readModel.upsert');
const { shadowName } = require('./rebuild.shadow');

const T = (name) => `analytics."${name}"`;

async function columnsOf(table, transaction) {
  const [rows] = await sequelize.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :table AND is_generated = 'NEVER' ORDER BY ordinal_position`,
    { replacements: { table }, transaction }
  );
  return rows.map((r) => `"${r.column_name}"`).join(', ');
}

/** Chaves (como objeto) dos agregados que eventos aplicados depois da fotografia atualizaram. */
async function duringRebuildKeys(def, scope, { snapshotText, snapshotAt, windowMinutes }, transaction) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT aggregate_key FROM analytics.rm_applied_events
      WHERE read_model = :model AND company_id = :companyId AND aggregate_key IS NOT NULL
        AND applied_at >= CAST(:snapshotAt AS timestamptz) - make_interval(mins => :windowMinutes)
        AND NOT pg_visible_in_snapshot((((pg_current_xact_id()::text::bigint >> 32) << 32) + xmin::text::bigint)::text::xid8, CAST(:snapshotText AS pg_snapshot))`,
    { replacements: { model: def.name, companyId: scope.companyId, snapshotAt, windowMinutes, snapshotText }, transaction }
  );
  return rows.map((r) => Object.fromEntries(aggregateColumnsOf(def).map((c, i) => [c, JSON.parse(r.aggregate_key)[i]])));
}

async function replaceRows(def, scope, transaction) {
  const columns = await columnsOf(def.name, transaction);
  await sequelize.query(`DELETE FROM ${T(def.name)} WHERE company_id = :companyId`, { replacements: scope, transaction });
  await sequelize.query(
    `INSERT INTO ${T(def.name)} (${columns}) SELECT ${columns} FROM ${T(shadowName(def.name))} WHERE company_id = :companyId`,
    { replacements: scope, transaction }
  );
}

/** Faz a troca. Devolve { reapplied }: agregados recalculados por terem sido tocados durante a reconstrução. */
async function swapShadow(def, scope, ctx, transaction) {
  await sequelize.query(`LOCK TABLE ${T(def.name)} IN SHARE ROW EXCLUSIVE MODE`, { transaction });
  const touched = await duringRebuildKeys(def, scope, ctx, transaction); // com a tabela travada, nenhum worker grava mais: a lista é completa
  await replaceRows(def, scope, transaction);
  for (const key of touched) {
    const result = await def.recompute({ ...scope, key, limit: null, asOfDate: ctx.asOfDate, now: ctx.now, event: null, transaction });
    await upsertAggregate(def, { ...scope, key, fields: result.fields, rows: result.rows, sourceSnapshotAt: result.sourceSnapshotAt || ctx.now }, transaction);
  }
  await sequelize.query('DELETE FROM analytics.rm_stale_aggregates WHERE read_model = :model AND company_id = :companyId AND marked_at <= CAST(:snapshotAt AS timestamptz)', {
    replacements: { model: def.name, companyId: scope.companyId, snapshotAt: ctx.snapshotAt }, transaction,
  });
  await sequelize.query(`DELETE FROM ${T(shadowName(def.name))} WHERE company_id = :companyId`, { replacements: scope, transaction });
  return { reapplied: touched.length };
}

module.exports = { swapShadow };
