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

/** Registro de controle de um replay de lote (N3): já RUNNING, do tipo REPLAY, na fonte do lote. Conta nos limites como uma execução, mas a Torre não o toma por "última execução". */
async function insertReplay(tenant, { sourceSystem, entity, requestedBy }, transaction) {
  const [row] = await select(
    `INSERT INTO governance.mig_runs (group_id, company_id, source_system, entity, kind, status, started_at, heartbeat_at, requested_by) VALUES (:groupId, :companyId, :sourceSystem, :entity, 'REPLAY', 'RUNNING', now(), now(), :requestedBy) RETURNING ${COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, sourceSystem, entity, requestedBy: requestedBy || null }, transaction
  );
  return row;
}

async function get(tenant, id, transaction) {
  const [row] = await select(`SELECT ${COLUMNS} FROM governance.mig_runs WHERE company_id = :companyId AND id = :id`, { companyId: tenant.companyId, id }, transaction);
  return row || null;
}

/** A execução mais recente da empresa (a Torre de controle a usa quando não se pede uma). */
async function latest(tenant, transaction) {
  const [row] = await select(`SELECT ${COLUMNS} FROM governance.mig_runs WHERE company_id = :companyId AND kind = 'RUN' ORDER BY created_at DESC, id DESC LIMIT 1`, { companyId: tenant.companyId }, transaction);
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

/** Renova o sinal de vida do registro de controle de um replay ainda RUNNING (R4-L6). */
async function touch(tenant, id, transaction) {
  await sequelize.query("UPDATE governance.mig_runs SET heartbeat_at = now() WHERE company_id = :companyId AND id = :id AND status = 'RUNNING'", { transaction, replacements: { companyId: tenant.companyId, id } });
}

/** Encerra como FAILED os registros de controle de replay sem sinal de vida há mais que `expireMinutes` (processo caído no meio do replay; R3-L6 e R4-L6: o sinal é o início ou a última renovação). Devolve quantos encerrou. */
async function expireStaleReplays(tenant, expireMinutes, transaction) {
  const rows = await select(
    `UPDATE governance.mig_runs SET status = 'FAILED', finished_at = now(), error = 'Replay interrompido: o registro expirou sem fim.'
      WHERE company_id = :companyId AND kind = 'REPLAY' AND status = 'RUNNING' AND GREATEST(COALESCE(started_at, created_at), COALESCE(heartbeat_at, started_at, created_at)) <= now() - make_interval(mins => :expireMinutes::int) RETURNING id`,
    { companyId: tenant.companyId, expireMinutes }, transaction
  );
  return rows.length;
}

/**
 * Execuções ativas (QUEUED, RUNNING ou PAUSED, com atividade — início ou lote gravado — dentro do prazo `expireMinutes`, então a execução longa que ainda grava lotes continua contando e só o processo caído expira) da empresa: `total` e as que miram a mesma fonte (`overlapping`). Pedido sem sistema ou
 * sem entidade mira todas, então cruza com qualquer outro.
 */
async function countActive(tenant, { sourceSystem, entity, expireMinutes }, transaction) {
  const [row] = await select(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE (:sourceSystem::text IS NULL OR r.source_system IS NULL OR r.source_system = :sourceSystem) AND (:entity::text IS NULL OR r.entity IS NULL OR r.entity = :entity))::int AS overlapping
       FROM governance.mig_runs r
      WHERE r.company_id = :companyId AND r.status IN ('QUEUED', 'RUNNING', 'PAUSED')
        AND GREATEST(COALESCE(r.started_at, r.created_at), COALESCE((SELECT max(COALESCE(b.finished_at, b.started_at, b.created_at)) FROM governance.mig_batches b WHERE b.run_id = r.id), r.created_at)) > now() - make_interval(mins => :expireMinutes::int)`,
    { companyId: tenant.companyId, sourceSystem: sourceSystem || null, entity: entity || null, expireMinutes }, transaction
  );
  return row;
}

module.exports = { lockCompany, countActive, expireStaleReplays, touch, insert, insertReplay, get, latest, claim, finish, pause, resume, listPaused, listQueued };
