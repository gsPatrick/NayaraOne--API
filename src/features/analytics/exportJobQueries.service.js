'use strict';

/**
 * M9-D701 — consultas do ciclo de vida da exportação (analytics.export_jobs): ler um pedido, pegar o próximo da fila sem disputa entre workers
 * (`FOR UPDATE SKIP LOCKED`), listar o que venceu, o que ficou preso em andamento e contar download. O pedido em si e as mudanças de estado ficam
 * em exportJobStore.service.js; aqui não há regra de negócio, só leitura e a contagem atômica.
 */
const { sequelize } = require('../../models');
const { assertWriter } = require('./analyticsStoreSupport');
const { updateExportJobState } = require('./exportJobStore.service');

const COLUMNS = `id, company_id AS "companyId", group_id AS "groupId", requested_by AS "requestedBy", dashboard_code AS "dashboardCode", metric_code AS "metricCode",
  scope, filters, risk_level AS "riskLevel", mfa_step_up_id AS "mfaStepUpId", status, row_count AS "rowCount", file_id AS "fileId", file_sha256 AS "fileSha256",
  expires_at AS "expiresAt", download_count AS "downloadCount", masked_fields AS "maskedFields", error_code AS "errorCode", created_at AS "createdAt", updated_at AS "updatedAt"`;

async function findExportJob(id, transaction) {
  const [rows] = await sequelize.query(`SELECT ${COLUMNS} FROM analytics.export_jobs WHERE id = CAST(:id AS uuid)`, { replacements: { id }, transaction });
  return rows[0] || null;
}

/** Pega o job QUEUED mais antigo que nenhum outro worker segurou e o passa a RUNNING (a transação do chamador deve ser curta). Null se a fila está vazia. */
async function claimNextQueuedJob(transaction) {
  await assertWriter(transaction);
  const [rows] = await sequelize.query(
    "SELECT id FROM analytics.export_jobs WHERE status = 'QUEUED' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED", { transaction }
  );
  if (!rows[0]) return null;
  await updateExportJobState(rows[0].id, { status: 'RUNNING' }, transaction);
  return findExportJob(rows[0].id, transaction);
}

/** Jobs READY cujo prazo já passou (arquivo a apagar). */
async function listExpiredReadyJobs(now, limit, transaction) {
  const [rows] = await sequelize.query(
    `SELECT ${COLUMNS} FROM analytics.export_jobs WHERE status = 'READY' AND expires_at <= :now ORDER BY expires_at LIMIT :limit`, { replacements: { now, limit }, transaction }
  );
  return rows;
}

/** Jobs RUNNING parados desde antes de `cutoff` (worker morreu no meio). */
async function listStaleRunningJobs(cutoff, limit, transaction) {
  const [rows] = await sequelize.query(
    `SELECT ${COLUMNS} FROM analytics.export_jobs WHERE status = 'RUNNING' AND updated_at <= :cutoff ORDER BY updated_at LIMIT :limit`, { replacements: { cutoff, limit }, transaction }
  );
  return rows;
}

/** +1 download, atômico (duas pessoas baixando juntas contam duas vezes). */
async function incrementDownloadCount(id, transaction) {
  await assertWriter(transaction);
  const [rows] = await sequelize.query(
    'UPDATE analytics.export_jobs SET download_count = download_count + 1, updated_at = now() WHERE id = CAST(:id AS uuid) RETURNING download_count AS "downloadCount"',
    { replacements: { id }, transaction }
  );
  return rows[0].downloadCount;
}

module.exports = { findExportJob, claimNextQueuedJob, listExpiredReadyJobs, listStaleRunningJobs, incrementDownloadCount };
