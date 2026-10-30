'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** SQL dos jobs de publicação (M9-D410). RLS por grupo e empresa vale na transação do chamador. */
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

const ACTIVE = Object.freeze(['PENDING', 'RUNNING', 'UNKNOWN']);
const COLUMNS = 'id, content_version_id, channel, adapter_code, connection_id, status, idempotency_key, scheduled_at, attempts, external_post_id, last_error_code';

const findByKey = async (companyId, key, transaction) => (await run(`SELECT ${COLUMNS} FROM marketing.publication_jobs WHERE company_id = :companyId AND idempotency_key = :key AND deleted_at IS NULL`, { companyId, key }, transaction))[0] || null;

const findActive = async (versionId, channel, transaction) => (await run(
  `SELECT ${COLUMNS} FROM marketing.publication_jobs WHERE content_version_id = :versionId AND channel = :channel AND status IN ('PENDING','RUNNING','UNKNOWN') AND deleted_at IS NULL`,
  { versionId, channel }, transaction
))[0] || null;

async function insert(tenant, actor, values, transaction) {
  const [row] = await run(
    `INSERT INTO marketing.publication_jobs (id, group_id, company_id, content_version_id, channel, adapter_code, connection_id, status, idempotency_key,
        scheduled_at, next_attempt_at, created_by, updated_by)
     VALUES (gen_random_uuid(), :groupId, :companyId, :versionId, :channel, :adapterCode, :connectionId, 'PENDING', :key, :scheduledAt, :scheduledAt, :actor, :actor)
     RETURNING ${COLUMNS}`,
    { groupId: tenant.groupId, companyId: tenant.companyId, versionId: values.versionId, channel: values.channel, adapterCode: values.adapterCode,
      connectionId: values.connectionId, key: values.idempotencyKey, scheduledAt: values.scheduledAt, actor: actor || null },
    transaction
  );
  return row;
}

/** Reagendar o mesmo post no mesmo horário depois de cancelar: a chave (única) é a mesma, então o job cancelado volta a PENDING. */
async function revive(jobId, values, actor, transaction) {
  const [row] = await run(
    `UPDATE marketing.publication_jobs SET status = 'PENDING', last_error_code = NULL, attempts = 0, adapter_code = :adapterCode, connection_id = :connectionId,
        next_attempt_at = scheduled_at, updated_by = :actor, updated_at = now() WHERE id = :jobId RETURNING ${COLUMNS}`,
    { jobId, adapterCode: values.adapterCode, connectionId: values.connectionId, actor: actor || null }, transaction
  );
  return row;
}

const lockJob = async (jobId, transaction) => (await run(
  `SELECT j.id, j.content_version_id, j.channel, j.connection_id, j.status, j.scheduled_at, j.external_post_id, v.content_item_id
     FROM marketing.publication_jobs j JOIN marketing.content_versions v ON v.id = j.content_version_id AND v.company_id = j.company_id
    WHERE j.id = :jobId AND j.deleted_at IS NULL FOR UPDATE OF j`, { jobId }, transaction
))[0] || null;

const itemOf = async (jobId, transaction) => (await run(
  `SELECT v.content_item_id FROM marketing.publication_jobs j JOIN marketing.content_versions v ON v.id = j.content_version_id AND v.company_id = j.company_id
    WHERE j.id = :jobId AND j.deleted_at IS NULL`, { jobId }, transaction
))[0]?.content_item_id || null;

const setStatus = (jobId, status, errorCode, actor, transaction) => run(
  'UPDATE marketing.publication_jobs SET status = :status, last_error_code = :errorCode, updated_by = :actor, updated_at = now() WHERE id = :jobId RETURNING id',
  { jobId, status, errorCode: errorCode || null, actor: actor || null }, transaction
);

const statusesOfVersion = async (versionId, transaction) => (await run(
  'SELECT id, channel, status, connection_id FROM marketing.publication_jobs WHERE content_version_id = :versionId AND deleted_at IS NULL ORDER BY channel', { versionId }, transaction
));

const hasReconciliation = async (jobId, transaction) => (await run(
  "SELECT 1 AS ok FROM marketing.publication_results WHERE job_id = :jobId AND outcome = 'RECONCILED_NOT_FOUND' LIMIT 1", { jobId }, transaction
)).length > 0;

const dropScheduleCheck = (versionId, actor, transaction) => run(
  "UPDATE marketing.content_versions SET checks_json = checks_json - 'schedule', updated_by = :actor, updated_at = now() WHERE id = :versionId RETURNING id",
  { versionId, actor: actor || null }, transaction
);

module.exports = { ACTIVE, itemOf, findByKey, findActive, insert, revive, lockJob, setStatus, statusesOfVersion, hasReconciliation, dropScheduleCheck };
