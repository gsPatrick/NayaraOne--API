'use strict';

/**
 * M9-D687 — consultas de leitura de painéis para a camada src/features/analytics/dashboards (que não importa models nem
 * sequelize, regra de lint da M9-D613): painel PUBLICADO por código com precedência empresa > grupo > catálogo global, e a
 * pergunta "o painel tem indicador CRITICAL?" (decide o log de abertura).
 */
const { sequelize } = require('../../models');

async function findPublishedDashboard({ code, companyId, groupId }, transaction) {
  const [rows] = await sequelize.query(
    `SELECT * FROM analytics.dashboard_definitions
      WHERE dashboard_code = :code AND status = 'PUBLISHED'
        AND ((company_id = :companyId) OR (company_id IS NULL AND group_id = :groupId) OR (company_id IS NULL AND group_id IS NULL))
      ORDER BY (company_id IS NULL), (group_id IS NULL) LIMIT 1`,
    { replacements: { code, companyId, groupId }, transaction }
  );
  return rows[0] || null;
}

async function dashboardHasCriticalMetric(dashboardId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT 1 FROM analytics.dashboard_widgets w JOIN analytics.metric_definitions m ON m.metric_code = w.metric_code
      WHERE w.dashboard_id = :id AND m.status = 'PUBLISHED' AND m.criticality = 'CRITICAL' LIMIT 1`,
    { replacements: { id: dashboardId }, transaction }
  );
  return rows.length > 0;
}

/**
 * M9-D634 — dados do indicador para o painel: definição vigente de cada código (a da empresa, senão a do grupo, senão a global; mesma precedência da
 * leitura de métricas) e as linhas de dimensão do snapshot da data-base (a revisão mais nova de cada chave), na versão da métrica já resolvida.
 */
async function listMetricMeta(codes, transaction) {
  if (!codes.length) return [];
  const [rows] = await sequelize.query(
    `SELECT DISTINCT ON (d.metric_code) d.metric_code AS "metricCode", d.name, d.domain, d.criticality, d.drilldown_enabled AS "drilldownEnabled"
       FROM analytics.metric_definitions d WHERE d.metric_code IN (:codes) AND d.status = 'PUBLISHED'
      ORDER BY d.metric_code, (d.company_id IS NULL), (d.group_id IS NULL)`,
    { replacements: { codes }, transaction }
  );
  return rows;
}

async function listDimensionSnapshots({ metricCode, version, companyId, asOfDate }, transaction) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT ON (s.dimension_key) s.dimension_key AS key, s.value_numeric::text AS value, s.status
       FROM analytics.metric_snapshots s
       JOIN analytics.metric_definitions d ON d.id = s.metric_id
       JOIN analytics.metric_versions v ON v.id = s.metric_version_id
      WHERE d.metric_code = :metricCode AND v.version = :version AND s.scope_type = 'COMPANY' AND s.scope_id = :companyId
        AND s.as_of_date = :asOfDate AND s.dimension_key <> ''
      ORDER BY s.dimension_key, s.revision_no DESC`,
    { replacements: { metricCode, version, companyId, asOfDate }, transaction }
  );
  return rows;
}

module.exports = { findPublishedDashboard, dashboardHasCriticalMetric, listMetricMeta, listDimensionSnapshots };
