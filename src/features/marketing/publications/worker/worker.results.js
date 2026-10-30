'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { redactDeep } = require('../../../../shared/redaction');

const MARKER = '[REDIGIDO]';
/**
 * Segredo dentro de texto (token no meio de uma mensagem de erro, "Bearer ..." no meio da frase) também sai: a redação do banco olha o nome da chave e o início do texto, então a
 * biblioteca única de redaction varre os valores antes de gravar, com o marcador único do Marketing no lugar do [REDACTED] dela (M9-D437, adv_11).
 */
const redactResponse = (response) => JSON.parse(JSON.stringify(redactDeep(response, { secretsOnly: true })).split('[REDACTED]').join(MARKER));

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
        metrics: JSON.stringify(metrics), response: JSON.stringify(redactResponse(response)), actor,
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
