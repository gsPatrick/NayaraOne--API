'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/**
 * Resultados das tentativas (publication_results, append-only: o banco recusa UPDATE e DELETE e redige segredo de response_redacted_json). Cada tentativa,
 * reconciliação e coleta de métrica é uma linha nova. Só entram aqui dados do provedor já reduzidos ao necessário: nunca o corpo bruto da resposta.
 */
async function insertResult(job, { outcome, attemptNo, externalPostId = null, externalUrl = null, providerStatus = null, metrics = {}, response = {}, actor = null }, transaction) {
  await sequelize.query(
    `INSERT INTO marketing.publication_results (id, group_id, company_id, job_id, attempt_no, outcome, external_post_id, external_url, provider_status, metrics_json, response_redacted_json, created_by)
     VALUES (gen_random_uuid(), :groupId, :companyId, :jobId, :attemptNo, :outcome, :externalPostId, :externalUrl, :providerStatus, CAST(:metrics AS jsonb), CAST(:response AS jsonb), :actor)`,
    {
      replacements: {
        groupId: job.group_id, companyId: job.company_id, jobId: job.id, attemptNo: Math.max(attemptNo || job.attempts || 1, 1), outcome, externalPostId, externalUrl, providerStatus,
        metrics: JSON.stringify(metrics), response: JSON.stringify(response), actor,
      },
      transaction, type: QueryTypes.INSERT,
    }
  );
}

/** Dias (D+N) das coletas de métrica já gravadas para o job. */
async function collectedDays(jobId, transaction) {
  const rows = await sequelize.query(
    "SELECT (metrics_json->>'day')::int AS day FROM marketing.publication_results WHERE job_id = :jobId AND outcome = 'METRICS'",
    { replacements: { jobId }, transaction, type: QueryTypes.SELECT }
  );
  return rows.map((r) => r.day);
}

module.exports = { insertResult, collectedDays };
