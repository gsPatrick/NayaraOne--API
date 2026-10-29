'use strict';

/**
 * M9-D693 — consultas de LEITURA do briefing da NAY Diretoria (briefs/*.js não importa models nem sequelize, regra de lint da M9-D613):
 * painéis publicados e as métricas dos seus widgets, alertas do período e o briefing vigente para exibição. Só lê o schema analytics, sempre
 * sob o RLS do tenant da transação; nenhum texto de consulta vem de fora (valores por parâmetro).
 */
const { sequelize } = require('../../models');

/**
 * Widgets de métrica dos painéis PUBLICADOS visíveis à empresa (versão da empresa > do grupo > global, por código de painel). Uma linha por
 * widget com métrica: painel, papéis de audiência, permissão exigida, métrica e configuração do widget (semáforo).
 */
async function listPublishedMetricWidgets({ companyId, groupId }, transaction) {
  const [rows] = await sequelize.query(
    `WITH dash AS (
       SELECT DISTINCT ON (d.dashboard_code) d.id, d.dashboard_code, d.audience_roles, d.required_permission, d.domain
         FROM analytics.dashboard_definitions d
        WHERE d.status = 'PUBLISHED'
          AND (d.company_id = :companyId OR (d.company_id IS NULL AND d.group_id = :groupId) OR (d.company_id IS NULL AND d.group_id IS NULL))
        ORDER BY d.dashboard_code, (d.company_id IS NULL), (d.group_id IS NULL)
     )
     SELECT dash.dashboard_code AS "dashboardCode", dash.audience_roles AS "audienceRoles", dash.required_permission AS "requiredPermission",
            w.metric_code AS "metricCode", w.position, w.config
       FROM dash JOIN analytics.dashboard_widgets w ON w.dashboard_id = dash.id
      WHERE w.metric_code IS NOT NULL
      ORDER BY dash.dashboard_code, w.position`,
    { replacements: { companyId, groupId }, transaction }
  );
  return rows;
}

/**
 * Alertas da empresa relevantes ao período: os ainda não resolvidos (qualquer data de abertura) e os abertos ou resolvidos DENTRO do
 * período (datas de calendário de São Paulo). Com o domínio da métrica de cada um (para o filtro por permissão).
 */
async function listBriefAlerts({ companyId, periodStart, periodEnd }, transaction) {
  const [rows] = await sequelize.query(
    `SELECT i.id, d.alert_code AS "alertCode", d.metric_code AS "metricCode", i.status, i.severity, i.opened_at AS "openedAt",
            i.resolved_at AS "resolvedAt", i.last_value AS "lastValue", i.occurrence_count AS "occurrenceCount", m.domain
       FROM analytics.alert_instances i JOIN analytics.alert_definitions d ON d.id = i.alert_definition_id
       LEFT JOIN LATERAL (SELECT md.domain FROM analytics.metric_definitions md WHERE md.metric_code = d.metric_code
                           ORDER BY (md.company_id IS NULL), (md.group_id IS NULL) LIMIT 1) m ON TRUE
      WHERE i.company_id = :companyId
        AND (i.status <> 'RESOLVED'
             OR (i.resolved_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN CAST(:periodStart AS date) AND CAST(:periodEnd AS date)
             OR (i.opened_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN CAST(:periodStart AS date) AND CAST(:periodEnd AS date))
      ORDER BY i.opened_at DESC, i.id`,
    { replacements: { companyId, periodStart, periodEnd }, transaction }
  );
  return rows;
}

/** Briefing vigente (não SUPERSEDED) mais recente do tipo; opcionalmente de um período exato. null se não há. */
async function findCurrentBrief({ companyId, groupId, briefType, periodStart = null, periodEnd = null }, transaction) {
  const [rows] = await sequelize.query(
    `SELECT id, company_id AS "companyId", group_id AS "groupId", brief_type AS "briefType", period_start AS "periodStart", period_end AS "periodEnd",
            generated_at AS "generatedAt", ai_run_id AS "aiRunId", status, content, source_refs AS "sourceRefs",
            freshness_summary AS "freshnessSummary", quality_summary AS "qualitySummary", blocked_reason AS "blockedReason"
       FROM analytics.executive_briefs
      WHERE company_id IS NOT DISTINCT FROM :companyId AND group_id = :groupId AND brief_type = :briefType AND status <> 'SUPERSEDED'
        AND (CAST(:periodStart AS date) IS NULL OR period_start = CAST(:periodStart AS date))
        AND (CAST(:periodEnd AS date) IS NULL OR period_end = CAST(:periodEnd AS date))
      ORDER BY period_end DESC, generated_at DESC LIMIT 1`,
    { replacements: { companyId, groupId, briefType, periodStart, periodEnd }, transaction }
  );
  return rows[0] || null;
}

module.exports = { listPublishedMetricWidgets, listBriefAlerts, findCurrentBrief };
