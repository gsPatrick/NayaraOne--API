'use strict';

/**
 * M9-D616 / M9-D617 — fábrica dos read models do BI que guardam VÁRIAS LINHAS por agregado (uma por dimensão), sobre o contrato de
 * `aggregateColumns` da M9-D618. Cada read model declara só o que é dele:
 *
 *   defineAggregateModel({
 *     name, version, keyColumns, aggregateColumns,        // a chave inteira e o subconjunto que identifica o agregado
 *     eventTypes, keyOf,                                  // keyOf(event, { now, transaction }) -> chave do agregado (pode ser async) ou null
 *     params(scope, transaction) -> { ... },              // parâmetros do administrador que a consulta usa (replacements nomeados)
 *     slice({ where, sql, params }) -> SQL,                     // consulta GROUP BY da fonte, restrita ao agregado por `where({ coluna: expressão })`
 *     schedule: { kind: 'today' | 'recent_days' | 'keys', ... },   // o que depende do relógio (null = só eventos)
 *     keysSql({ full }) -> SQL,                           // chaves do agregado na fonte (rebuild e agenda por 'keys')
 *   })
 *
 * A consulta devolve uma linha por dimensão, com as colunas da chave e os campos; o resultado SUBSTITUI as linhas do agregado (estado,
 * nunca delta). Dimensão sem fonte some (nenhuma linha zerada fica para trás), então o rebuild reproduz o incremental. Só ids e
 * agregados: nenhuma consulta traz nome nem documento de pessoa.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { businessDateKey } = require('../../../utils/businessDate');
const clock = require('../metrics/clock');
const { sqlDay, sqlMonth, TODAY_START, DAY_END, shiftDay } = require('./aggregateModel.sql');

const T = (name) => `analytics."${name}"`;

function whereBuilder(aggregateColumns) {
  return (exprs) => aggregateColumns.filter((c) => exprs[c]).map((c) => ` AND ${exprs[c]} = :agg_${c}`).join('');
}

function pick(row, columns) {
  return Object.fromEntries(columns.map((c) => [c, row[c]]));
}

function recomputeOf(cfg, aggregateColumns, dims) {
  const where = whereBuilder(aggregateColumns);
  return async function recompute({ companyId, groupId, key, now, transaction }) {
    const extra = cfg.params ? await cfg.params({ companyId, groupId }, transaction) : {};
    const agg = Object.fromEntries(aggregateColumns.map((c) => [`agg_${c}`, key[c]]));
    const today = key.as_of_date || businessDateKey(now);
    const [rows] = await sequelize.query(cfg.slice({ where, params: extra, sql: { day: sqlDay, month: sqlMonth, TODAY_START, DAY_END } }), { replacements: { companyId, today, ...extra, ...agg }, transaction });
    const fieldNames = Object.keys(rows[0] || {}).filter((c) => !cfg.keyColumns.includes(c));
    return { rows: rows.map((r) => ({ key: pick(r, dims), fields: pick(r, fieldNames) })), sourceSnapshotAt: now };
  };
}

async function existingKeys(cfg, aggregateColumns, companyId, transaction) {
  const cols = aggregateColumns.map((c) => `"${c}"::text AS "${c}"`).join(', ');
  const [rows] = await sequelize.query(`SELECT DISTINCT ${cols} FROM ${T(cfg.name)} WHERE company_id = :companyId`, { replacements: { companyId }, transaction });
  return rows;
}

async function sourceKeys(cfg, scope, full, now, transaction) {
  const extra = cfg.params ? await cfg.params(scope, transaction) : {};
  const [rows] = await sequelize.query(cfg.keysSql({ full }), { replacements: { companyId: scope.companyId, today: businessDateKey(now), ...extra }, transaction });
  return rows;
}

const dedupe = (keys, columns) => [...new Map(keys.map((k) => [JSON.stringify(columns.map((c) => k[c])), k])).values()];

function scheduledKeysOf(cfg, aggregateColumns) {
  const s = cfg.schedule;
  return async function scheduledKeys({ companyId, groupId, now, transaction }) {
    const today = businessDateKey(now);
    if (s.kind === 'today') return [{ as_of_date: today }];
    if (s.kind === 'recent_days') {
      const extra = await cfg.params({ companyId, groupId }, transaction);
      return Array.from({ length: extra.recalcDays }, (_, i) => ({ [s.column || 'day']: shiftDay(today, -i) }));
    }
    if (!aggregateColumns.length) return [{}]; // agregado da empresa inteira
    const source = await sourceKeys(cfg, { companyId, groupId }, false, now, transaction);
    return dedupe([...source, ...(await existingKeys(cfg, aggregateColumns, companyId, transaction))], aggregateColumns);
  };
}

function rebuildKeysOf(cfg, aggregateColumns) {
  return async function rebuildKeys({ companyId, groupId, transaction }) {
    const now = clock.now();
    if (cfg.schedule && cfg.schedule.kind === 'today') return [{ as_of_date: businessDateKey(now) }];
    if (!aggregateColumns.length) return [{}];
    return sourceKeys(cfg, { companyId, groupId }, true, now, transaction);
  };
}

function defineAggregateModel(cfg) {
  const aggregateColumns = cfg.aggregateColumns || cfg.keyColumns;
  const dims = cfg.keyColumns.filter((c) => !aggregateColumns.includes(c));
  const def = {
    name: cfg.name,
    version: cfg.version || 1,
    keyColumns: cfg.keyColumns,
    aggregateColumns,
    eventTypes: cfg.eventTypes,
    aggregateKey: cfg.keyOf,
    recompute: recomputeOf(cfg, aggregateColumns, dims),
    rebuild: { keys: rebuildKeysOf(cfg, aggregateColumns) },
  };
  if (cfg.schedule) def.scheduled = { keys: scheduledKeysOf(cfg, aggregateColumns) };
  return registerReadModel(def);
}

module.exports = { defineAggregateModel };
