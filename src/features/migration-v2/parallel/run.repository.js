'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const COLUMNS = 'id, window_id, run_number, status, error_code, started_at, finished_at, summary';

/** Abre a execução seguinte da janela (número = último + 1). A janela deve estar travada pelo chamador; o índice único parcial deixa uma só RUNNING. */
async function open(tenant, windowId, now, transaction) {
  const [row] = await select(
    `INSERT INTO governance.parallel_runs (group_id, company_id, window_id, run_number, started_at)
     SELECT :groupId, :companyId, :windowId, COALESCE(MAX(run_number), 0) + 1, :now FROM governance.parallel_runs WHERE window_id = :windowId RETURNING ${COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, windowId, now: now.toISOString() }, transaction
  );
  return row;
}

async function last(tenant, windowId, transaction) {
  const [row] = await select(`SELECT ${COLUMNS} FROM governance.parallel_runs WHERE company_id = :companyId AND window_id = :windowId ORDER BY run_number DESC LIMIT 1`, { companyId: tenant.companyId, windowId }, transaction);
  return row || null;
}

async function running(tenant, windowId, transaction) {
  const [row] = await select(`SELECT ${COLUMNS} FROM governance.parallel_runs WHERE company_id = :companyId AND window_id = :windowId AND status = 'RUNNING'`, { companyId: tenant.companyId, windowId }, transaction);
  return row || null;
}

/** Execução RUNNING que passou do prazo (processo caído) vira FAILED e libera a janela. Devolve as linhas afetadas. */
function failStale(tenant, windowId, cutoff, transaction) {
  return select(
    `UPDATE governance.parallel_runs SET status = 'FAILED', error_code = 'GOV_PARALLEL_RUN_TIMEOUT', finished_at = now()
      WHERE company_id = :companyId AND window_id = :windowId AND status = 'RUNNING' AND started_at < :cutoff RETURNING ${COLUMNS}`,
    { companyId: tenant.companyId, windowId, cutoff: cutoff.toISOString() }, transaction
  );
}

async function finish(tenant, id, status, errorCode, summary, now, transaction) {
  const [row] = await select(
    `UPDATE governance.parallel_runs SET status = :status, error_code = :errorCode, summary = CAST(:summary AS jsonb), finished_at = :now
      WHERE company_id = :companyId AND id = :id AND status = 'RUNNING' RETURNING ${COLUMNS}`,
    { companyId: tenant.companyId, id, status, errorCode: errorCode || null, summary: JSON.stringify(summary || {}), now: now.toISOString() }, transaction
  );
  return row || null;
}

const list = (tenant, windowId, limit, transaction) => select(
  `SELECT ${COLUMNS} FROM governance.parallel_runs WHERE company_id = :companyId AND window_id = :windowId ORDER BY run_number DESC LIMIT :limit`, { companyId: tenant.companyId, windowId, limit }, transaction
);

module.exports = { open, last, running, failStale, finish, list };
