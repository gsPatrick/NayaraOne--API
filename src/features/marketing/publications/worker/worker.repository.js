'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** SQL do worker de publicação (M9-D411). RLS por grupo e empresa vale na transação do chamador; toda seleção de trabalho usa FOR UPDATE SKIP LOCKED. */
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

const COLUMNS = `j.id, j.group_id, j.company_id, j.content_version_id, j.channel, j.adapter_code, j.connection_id, j.status, j.idempotency_key, j.scheduled_at,
  j.next_attempt_at, j.attempts, j.external_post_id, j.external_url, j.provider_status, j.started_at, j.unknown_since, j.next_check_at, j.escalated_at, j.published_at,
  j.last_error_code, j.created_by, v.content_item_id AS item_id, i.campaign_id`;
const FROM = `FROM marketing.publication_jobs j
  JOIN marketing.content_versions v ON v.id = j.content_version_id AND v.company_id = j.company_id
  JOIN marketing.content_items i ON i.id = v.content_item_id AND i.company_id = j.company_id`;
const DUE_AT = 'COALESCE(j.next_attempt_at, j.scheduled_at)';

/** Jobs PENDING vencidos (agendados e fora da espera), na ordem do vencimento; `after` = { at, id } continua a leitura depois do último visto. */
function selectDue({ now, limit, after }, transaction) {
  const cursor = after ? `AND (${DUE_AT}, j.id) > (CAST(:afterAt AS timestamptz), CAST(:afterId AS uuid))` : '';
  return run(
    `SELECT ${COLUMNS} ${FROM}
      WHERE j.status = 'PENDING' AND j.deleted_at IS NULL AND j.scheduled_at <= :now AND ${DUE_AT} <= :now ${cursor}
      ORDER BY ${DUE_AT}, j.id LIMIT :limit FOR UPDATE OF j SKIP LOCKED`,
    { now, limit, afterAt: after && after.at, afterId: after && after.id }, transaction
  );
}

/** RUNNING sem post confirmado desde antes do corte: o processo caiu no meio (M9-D411 item 9). */
const selectAbandoned = ({ cutoff, limit }, transaction) => run(
  `SELECT ${COLUMNS} ${FROM} WHERE j.status = 'RUNNING' AND j.external_post_id IS NULL AND j.deleted_at IS NULL AND j.started_at <= :cutoff
    ORDER BY j.started_at, j.id LIMIT :limit FOR UPDATE OF j SKIP LOCKED`, { cutoff, limit }, transaction
);

const selectUnknownDue = ({ now, limit }, transaction) => run(
  `SELECT ${COLUMNS} ${FROM} WHERE j.status = 'UNKNOWN' AND j.deleted_at IS NULL AND COALESCE(j.next_check_at, j.unknown_since) <= :now
    ORDER BY COALESCE(j.next_check_at, j.unknown_since), j.id LIMIT :limit FOR UPDATE OF j SKIP LOCKED`, { now, limit }, transaction
);

/** Post aceito pelo canal que ainda não está no ar (PROCESSING): o job segue RUNNING até o status real. */
const selectStatusDue = ({ now, limit }, transaction) => run(
  `SELECT ${COLUMNS} ${FROM} WHERE j.status = 'RUNNING' AND j.external_post_id IS NOT NULL AND j.deleted_at IS NULL AND j.next_check_at <= :now
    ORDER BY j.next_check_at, j.id LIMIT :limit FOR UPDATE OF j SKIP LOCKED`, { now, limit }, transaction
);

/** Publicados na janela das métricas que ainda têm ponto por coletar (menos resultados METRICS do que pontos). */
const selectMetricsCandidates = ({ since, points, limit }, transaction) => run(
  `SELECT ${COLUMNS} ${FROM} WHERE j.status = 'PUBLISHED' AND j.external_post_id IS NOT NULL AND j.published_at >= :since AND j.deleted_at IS NULL
      AND (SELECT count(*) FROM marketing.publication_results r WHERE r.job_id = j.id AND r.outcome = 'METRICS') < :points
    ORDER BY j.published_at, j.id LIMIT :limit FOR UPDATE OF j SKIP LOCKED`, { since, points, limit }, transaction
);

const lockById = async (jobId, transaction) => (await run(`SELECT ${COLUMNS} ${FROM} WHERE j.id = :jobId AND j.deleted_at IS NULL FOR UPDATE OF j`, { jobId }, transaction))[0] || null;

const FIELD_COLUMN = Object.freeze({
  status: 'status', lastErrorCode: 'last_error_code', attempts: 'attempts', nextAttemptAt: 'next_attempt_at', startedAt: 'started_at', unknownSince: 'unknown_since',
  nextCheckAt: 'next_check_at', escalatedAt: 'escalated_at', publishedAt: 'published_at', providerStatus: 'provider_status', externalPostId: 'external_post_id', externalUrl: 'external_url',
});

/** Atualiza só os campos conhecidos do job (nomes de coluna vêm da lista fechada acima, nunca do chamador). */
async function patch(jobId, fields, transaction) {
  const keys = Object.keys(fields).filter((k) => FIELD_COLUMN[k] && fields[k] !== undefined);
  const sets = keys.map((k) => `${FIELD_COLUMN[k]} = :${k}`).concat('updated_at = now()');
  const replacements = { jobId, ...Object.fromEntries(keys.map((k) => [k, fields[k]])) };
  await run(`UPDATE marketing.publication_jobs SET ${sets.join(', ')} WHERE id = :jobId RETURNING id`, replacements, transaction);
}

module.exports = { selectDue, selectAbandoned, selectUnknownDue, selectStatusDue, selectMetricsCandidates, lockById, patch };
