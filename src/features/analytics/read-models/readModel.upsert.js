'use strict';

/**
 * M9-D607 (3.2 passos 4 a 6) — escrita de um agregado do read model: trava, UPSERT do ESTADO (nunca delta) e marcação de agregado
 * adiado. Colunas comuns de todo read model: company_id, group_id, source_snapshot_at (só avança), refreshed_at e version.
 * Identificadores vêm da definição registrada (validados), valores sempre por parâmetro.
 */
const { sequelize } = require('../../../models');
const { IDENT } = require('./readModel.registry');

const T = (name) => `analytics."${name}"`;

function jsonOrValue(v) {
  return v !== null && typeof v === 'object' && !(v instanceof Date) ? { json: JSON.stringify(v) } : { value: v };
}

/** Serializa dois workers no mesmo agregado (mesmo que a linha ainda não exista): trava de transação por hash de (modelo, empresa, chave). */
async function lockAggregate(def, companyId, key, transaction) {
  const text = `${def.name}|${companyId}|${JSON.stringify(def.keyColumns.map((c) => key[c]))}`;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:t, 0))', { replacements: { t: text }, transaction });
}

const keyText = (def, key) => JSON.stringify(def.keyColumns.map((c) => String(key[c])));

async function upsertAggregate(def, { companyId, groupId, key, fields, sourceSnapshotAt }, transaction, table = def.name) {
  for (const c of def.keyColumns) if (key[c] === undefined || key[c] === null) throw new Error(`Read model ${def.name}: chave sem ${c}.`);
  const fieldNames = Object.keys(fields || {});
  if (!fieldNames.every((f) => IDENT.test(f))) throw new Error(`Read model ${def.name}: nome de coluna inválido em fields.`);
  const columns = ['company_id', 'group_id', ...def.keyColumns, ...fieldNames];
  const replacements = { companyId, groupId, snapshotAt: sourceSnapshotAt || null, version: def.version };
  const values = [':companyId', ':groupId'];
  [...def.keyColumns.map((c) => key[c]), ...fieldNames.map((f) => fields[f])].forEach((raw, i) => {
    const { json, value } = jsonOrValue(raw);
    replacements[`v${i}`] = json !== undefined ? json : value;
    values.push(json !== undefined ? `CAST(:v${i} AS jsonb)` : `:v${i}`);
  });
  const updates = fieldNames.map((f) => `"${f}" = EXCLUDED."${f}"`);
  updates.push('source_snapshot_at = GREATEST(t.source_snapshot_at, EXCLUDED.source_snapshot_at)', 'refreshed_at = EXCLUDED.refreshed_at', 'version = EXCLUDED.version', 'group_id = EXCLUDED.group_id');
  await sequelize.query(
    `INSERT INTO ${T(table)} AS t (${columns.map((c) => `"${c}"`).join(', ')}, source_snapshot_at, refreshed_at, version)
     VALUES (${values.join(', ')}, :snapshotAt, now(), :version)
     ON CONFLICT (company_id, ${def.keyColumns.map((c) => `"${c}"`).join(', ')}) DO UPDATE SET ${updates.join(', ')}`,
    { replacements, transaction }
  );
}

async function markStale(def, { companyId, groupId, key }, transaction) {
  await sequelize.query(
    `INSERT INTO ${T('rm_stale_aggregates')} (read_model, company_id, group_id, aggregate_key, reason)
     VALUES (:model, :companyId, :groupId, :aggregateKey, 'ROW_LIMIT')
     ON CONFLICT (read_model, company_id, aggregate_key) DO UPDATE SET marked_at = now()`,
    { replacements: { model: def.name, companyId, groupId, aggregateKey: keyText(def, key) }, transaction }
  );
}

async function clearStale(def, { companyId, key }, transaction) {
  await sequelize.query('DELETE FROM analytics.rm_stale_aggregates WHERE read_model = :model AND company_id = :companyId AND aggregate_key = :aggregateKey', {
    replacements: { model: def.name, companyId, aggregateKey: keyText(def, key) }, transaction,
  });
}

/** Agregados adiados do read model nesta empresa (chaves como objeto), do mais antigo para o mais novo. */
async function listStale(def, companyId, limit, transaction) {
  const [rows] = await sequelize.query(
    'SELECT aggregate_key FROM analytics.rm_stale_aggregates WHERE read_model = :model AND company_id = :companyId ORDER BY marked_at LIMIT :limit',
    { replacements: { model: def.name, companyId, limit }, transaction }
  );
  return rows.map((r) => Object.fromEntries(def.keyColumns.map((c, i) => [c, JSON.parse(r.aggregate_key)[i]])));
}

module.exports = { lockAggregate, upsertAggregate, markStale, clearStale, listStale, keyText };
