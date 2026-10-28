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

module.exports = { findPublishedDashboard, dashboardHasCriticalMetric };
