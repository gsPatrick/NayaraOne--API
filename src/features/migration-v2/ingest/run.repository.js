'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const COLUMNS = 'id, status, source_system, entity, last_delta, requested_by, started_at, finished_at, summary, error, created_at';

async function insert(tenant, { sourceSystem, entity, lastDelta, requestedBy }, transaction) {
  const [row] = await select(
    `INSERT INTO governance.mig_runs (group_id, company_id, source_system, entity, last_delta, requested_by) VALUES (:groupId, :companyId, :sourceSystem, :entity, :lastDelta, :requestedBy) RETURNING ${COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, sourceSystem: sourceSystem || null, entity: entity || null, lastDelta: Boolean(lastDelta), requestedBy: requestedBy || null }, transaction
  );
  return row;
}

async function get(tenant, id, transaction) {
  const [row] = await select(`SELECT ${COLUMNS} FROM governance.mig_runs WHERE company_id = :companyId AND id = :id`, { companyId: tenant.companyId, id }, transaction);
  return row || null;
}

/** A execução mais recente da empresa (a Torre de controle a usa quando não se pede uma). */
async function latest(tenant, transaction) {
  const [row] = await select(`SELECT ${COLUMNS} FROM governance.mig_runs WHERE company_id = :companyId ORDER BY created_at DESC, id DESC LIMIT 1`, { companyId: tenant.companyId }, transaction);
  return row || null;
}

/** QUEUED -> RUNNING atomicamente: só uma instância reivindica a execução. */
async function claim(tenant, id, transaction) {
  const [row] = await select(
    `UPDATE governance.mig_runs SET status = 'RUNNING', started_at = now() WHERE company_id = :companyId AND id = :id AND status = 'QUEUED' RETURNING ${COLUMNS}`,
    { companyId: tenant.companyId, id }, transaction
  );
  return row || null;
}

async function finish(tenant, id, status, summary, error, transaction) {
  await sequelize.query(
    'UPDATE governance.mig_runs SET status = :status, finished_at = now(), summary = CAST(:summary AS jsonb), error = :error WHERE company_id = :companyId AND id = :id',
    { transaction, replacements: { companyId: tenant.companyId, id, status, summary: JSON.stringify(summary), error: error || null } }
  );
}

/** Execuções QUEUED da empresa, mais antigas primeiro (o job as retoma se a partida imediata se perdeu). */
function listQueued(tenant, transaction) {
  return select(`SELECT ${COLUMNS} FROM governance.mig_runs WHERE company_id = :companyId AND status = 'QUEUED' ORDER BY created_at LIMIT 20`, { companyId: tenant.companyId }, transaction);
}

module.exports = { insert, get, latest, claim, finish, listQueued };
