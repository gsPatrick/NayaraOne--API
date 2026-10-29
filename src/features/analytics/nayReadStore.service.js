'use strict';

/**
 * M9-D695 — consultas de LEITURA das ferramentas da NAY Diretoria (briefs/nayTools*.js, que não importam models nem sequelize,
 * regra de lint da M9-D613): decomposição de um indicador por dimensão, alertas da empresa e último dia com número gravado.
 * Só lê o schema analytics, sempre sob o RLS do tenant da transação; nenhum texto de consulta vem do chamador (valores por parâmetro).
 */
const { sequelize } = require('../../models');

const escapeLike = (text) => String(text).replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Uma linha por chave de dimensão de `dimension` (forma canônica de uma dimensão: `dimensão=valor`) na data-base: a versão mais nova
 * e, nela, a maior revisão. Ordenada pela chave.
 */
async function listDimensionSnapshots({ metricId, companyId, asOfDate, dimension, limit }, transaction) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT ON (s.dimension_key) s.dimension_key AS "dimensionKey", s.value_numeric, s.value_text, s.status, s.metric_version_id,
            s.revision_no, s.source_snapshot_at, s.refreshed_at, s.as_of_date
       FROM analytics.metric_snapshots s JOIN analytics.metric_versions v ON v.id = s.metric_version_id
      WHERE s.metric_id = :metricId AND s.scope_type = 'COMPANY' AND s.scope_id = :companyId AND s.as_of_date = :asOfDate
        AND s.dimension_key LIKE :prefix ESCAPE '\\'
      ORDER BY s.dimension_key, v.version DESC, s.revision_no DESC
      LIMIT :limit`,
    { replacements: { metricId, companyId, asOfDate, prefix: `${escapeLike(dimension)}=%`, limit }, transaction }
  );
  return rows;
}

/** Alertas da empresa com a métrica de cada um (para filtrar pelo domínio que o usuário pode ver), mais recentes primeiro. */
async function listAlertInstances({ companyId, status, severity, limit }, transaction) {
  const [rows] = await sequelize.query(
    `SELECT i.id, d.alert_code AS "alertCode", d.metric_code AS "metricCode", i.status, i.severity, i.opened_at AS "openedAt",
            i.acknowledged_at AS "acknowledgedAt", i.resolved_at AS "resolvedAt", i.last_evaluated_at AS "lastEvaluatedAt", i.last_value AS "lastValue",
            i.occurrence_count AS "occurrenceCount", m.domain
       FROM analytics.alert_instances i JOIN analytics.alert_definitions d ON d.id = i.alert_definition_id
       LEFT JOIN LATERAL (SELECT md.domain FROM analytics.metric_definitions md WHERE md.metric_code = d.metric_code
                           ORDER BY (md.company_id IS NULL), (md.group_id IS NULL) LIMIT 1) m ON TRUE
      WHERE i.company_id = :companyId AND (CAST(:status AS text) IS NULL OR i.status = CAST(:status AS text))
        AND (CAST(:severity AS text) IS NULL OR i.severity = CAST(:severity AS text))
      ORDER BY i.opened_at DESC, i.id LIMIT :limit`,
    { replacements: { companyId, status: status || null, severity: severity || null, limit }, transaction }
  );
  return rows;
}

/** Último dia (até `upTo`) com número gravado da métrica na empresa, com os instantes da fonte e da gravação; null se nunca houve. */
async function latestSnapshotFreshness({ metricId, companyId, upTo }, transaction) {
  const [rows] = await sequelize.query(
    `SELECT s.as_of_date AS "asOfDate", s.source_snapshot_at AS "sourceSnapshotAt", s.refreshed_at AS "refreshedAt", s.status
       FROM analytics.metric_snapshots s
      WHERE s.metric_id = :metricId AND s.scope_type = 'COMPANY' AND s.scope_id = :companyId AND s.dimension_key = '' AND s.as_of_date <= :upTo
      ORDER BY s.as_of_date DESC, s.revision_no DESC LIMIT 1`,
    { replacements: { metricId, companyId, upTo }, transaction }
  );
  return rows[0] || null;
}

module.exports = { listDimensionSnapshots, listAlertInstances, latestSnapshotFreshness };
