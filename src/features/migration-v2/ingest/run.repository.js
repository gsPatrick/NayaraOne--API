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

/** RUNNING -> PAUSED (relógios fora do limite, M9-D908): sem fim, para o job de retomada achá-la; o checkpoint de cada fonte fica onde estava. */
async function pause(tenant, id, summary, transaction) {
  await sequelize.query(
    "UPDATE governance.mig_runs SET status = 'PAUSED', finished_at = NULL, summary = CAST(:summary AS jsonb), error = NULL WHERE company_id = :companyId AND id = :id AND status = 'RUNNING'",
    { transaction, replacements: { companyId: tenant.companyId, id, summary: JSON.stringify(summary) } }
  );
}

/** PAUSED -> QUEUED atomicamente: só quem retoma primeiro vence. */
async function resume(tenant, id, transaction) {
  const [row] = await select("UPDATE governance.mig_runs SET status = 'QUEUED' WHERE company_id = :companyId AND id = :id AND status = 'PAUSED' RETURNING id", { companyId: tenant.companyId, id }, transaction);
  return Boolean(row);
}

const listPaused = (tenant, transaction) => select(`SELECT ${COLUMNS} FROM governance.mig_runs WHERE company_id = :companyId AND status = 'PAUSED' ORDER BY created_at LIMIT 20`, { companyId: tenant.companyId }, transaction);

/** Execuções QUEUED da empresa, mais antigas primeiro (o job as retoma se a partida imediata se perdeu). */
function listQueued(tenant, transaction) {
  return select(`SELECT ${COLUMNS} FROM governance.mig_runs WHERE company_id = :companyId AND status = 'QUEUED' ORDER BY created_at LIMIT 20`, { companyId: tenant.companyId }, transaction);
}

/** Serializa os pedidos de execução da empresa até o fim da transação: a contagem de ativas e o insert não se atropelam. */
async function lockCompany(tenant, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { transaction, replacements: { key: `mig_run_request:${tenant.companyId}` } });
}

/**
 * Execuções ativas (QUEUED, RUNNING ou PAUSED, ainda dentro do prazo `expireMinutes`) da empresa: `total` e as que miram a mesma fonte (`overlapping`). Pedido sem sistema ou
 * sem entidade mira todas, então cruza com qualquer outro.
 */
async function countActive(tenant, { sourceSystem, entity, expireMinutes }, transaction) {
  const [row] = await select(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE (:sourceSystem::text IS NULL OR source_system IS NULL OR source_system = :sourceSystem) AND (:entity::text IS NULL OR entity IS NULL OR entity = :entity))::int AS overlapping
       FROM governance.mig_runs
      WHERE company_id = :companyId AND status IN ('QUEUED', 'RUNNING', 'PAUSED') AND COALESCE(started_at, created_at) > now() - make_interval(mins => :expireMinutes::int)`,
    { companyId: tenant.companyId, sourceSystem: sourceSystem || null, entity: entity || null, expireMinutes }, transaction
  );
  return row;
}

module.exports = { lockCompany, countActive, insert, get, latest, claim, finish, pause, resume, listPaused, listQueued };
