'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const COLUMNS = 'id, context, run_id AS "runId", dry_run_id AS "dryRunId", readings, drift_ms AS "driftMs", max_drift_ms AS "maxDriftMs", status, checked_at AS "checkedAt"';

async function insert(tenant, check, transaction) {
  const [row] = await select(
    `INSERT INTO governance.mig_clock_checks (group_id, company_id, context, run_id, dry_run_id, readings, drift_ms, max_drift_ms, status)
     VALUES (:groupId, :companyId, :context, :runId, :dryRunId, CAST(:readings AS jsonb), :driftMs, :maxDriftMs, :status) RETURNING ${COLUMNS}`,
    {
      groupId: tenant.groupId, companyId: tenant.companyId, context: check.context, runId: check.runId || null, dryRunId: check.dryRunId || null,
      readings: JSON.stringify(check.readings), driftMs: check.driftMs === null ? null : check.driftMs, maxDriftMs: check.maxDriftMs, status: check.status,
    }, transaction
  );
  return row;
}

/** A conferência mais recente da empresa (ou null). */
async function latest(tenant, transaction) {
  const [row] = await select(`SELECT ${COLUMNS} FROM governance.mig_clock_checks WHERE company_id = :companyId ORDER BY checked_at DESC, id DESC LIMIT 1`, { companyId: tenant.companyId }, transaction);
  return row || null;
}

module.exports = { insert, latest };
