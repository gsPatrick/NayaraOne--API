'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { BATCH } = require('./ingest.constants');
const { assertTransition } = require('./batch.states');
const errors = require('./ingest.errors');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const COLUMNS = 'id, group_id, company_id, run_id, source_id, source_system, entity, from_token, to_token, row_count, status, attempts, replay_of, started_at, finished_at, root_hash, error, created_at';

async function insert(tenant, { runId, source, fromToken, toToken, replayOf }, transaction) {
  const [row] = await select(
    `INSERT INTO governance.mig_batches (group_id, company_id, run_id, source_id, source_system, entity, from_token, to_token, replay_of)
     VALUES (:groupId, :companyId, :runId, :sourceId, :sourceSystem, :entity, :fromToken, :toToken, :replayOf) RETURNING ${COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, runId, sourceId: source.id, sourceSystem: source.source_system, entity: source.entity, fromToken: fromToken ?? null, toToken: toToken ?? null, replayOf: replayOf || null },
    transaction
  );
  return row;
}

async function get(tenant, id, transaction) {
  const [row] = await select(`SELECT ${COLUMNS} FROM governance.mig_batches WHERE company_id = :companyId AND id = :id`, { companyId: tenant.companyId, id }, transaction);
  return row || null;
}

/**
 * Muda o estado do lote respeitando a máquina de estados. A mudança é condicionada ao estado lido (UPDATE ... WHERE status = :from): quem perde a corrida recebe
 * GOV_MIG_BATCH_INVALID_TRANSITION. RUNNING em fonte que já tem lote RUNNING recebe GOV_MIG_BATCH_RUNNING (índice parcial único).
 */
async function transition(tenant, id, to, fields, transaction) {
  const current = await get(tenant, id, transaction);
  if (!current) throw errors.batchNotFound();
  assertTransition(current.status, to);
  const sets = ['status = :to', 'updated_at = now()'];
  const replacements = { companyId: tenant.companyId, id, from: current.status, to };
  const columns = { toToken: 'to_token', rowCount: 'row_count', rootHash: 'root_hash', error: 'error' };
  for (const [key, column] of Object.entries(columns)) if (fields && fields[key] !== undefined) { sets.push(`${column} = :${key}`); replacements[key] = fields[key]; }
  if (to === BATCH.RUNNING) sets.push('started_at = now()', 'finished_at = NULL', 'attempts = attempts + 1');
  if ([BATCH.APPLIED, BATCH.FAILED, BATCH.ABORTED, BATCH.VERIFIED, BATCH.HASH_MISMATCH].includes(to)) sets.push('finished_at = now()');
  let rows;
  try {
    rows = await select(`UPDATE governance.mig_batches SET ${sets.join(', ')} WHERE company_id = :companyId AND id = :id AND status = :from RETURNING ${COLUMNS}`, replacements, transaction);
  } catch (err) {
    if (err.original && err.original.constraint === 'mig_batches_running_uq') throw errors.batchRunning();
    throw err;
  }
  if (!rows.length) throw errors.invalidTransition(current.status, to);
  return rows[0];
}

/** Lote RUNNING da fonte (no máximo um). */
async function findRunning(tenant, sourceId, transaction) {
  const [row] = await select(`SELECT ${COLUMNS} FROM governance.mig_batches WHERE company_id = :companyId AND source_id = :sourceId AND status = 'RUNNING'`, { companyId: tenant.companyId, sourceId }, transaction);
  return row || null;
}

/** Lotes da execução, em ordem de criação (relatório de lotes com hash). */
function listByRun(tenant, runId, transaction) {
  return select(`SELECT ${COLUMNS} FROM governance.mig_batches WHERE company_id = :companyId AND run_id = :runId ORDER BY created_at, id`, { companyId: tenant.companyId, runId }, transaction);
}

/** Últimos lotes confirmados de uma fonte (M9-D901 usa para a vazão). */
function listApplied(tenant, sourceId, limit, transaction) {
  return select(`SELECT ${COLUMNS} FROM governance.mig_batches WHERE company_id = :companyId AND source_id = :sourceId AND status IN ('APPLIED', 'VERIFIED') ORDER BY finished_at DESC LIMIT :limit`, { companyId: tenant.companyId, sourceId, limit }, transaction);
}

module.exports = { insert, get, transition, findRunning, listByRun, listApplied };
