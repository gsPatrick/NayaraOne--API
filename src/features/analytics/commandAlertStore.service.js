'use strict';

/**
 * M9-D685 — leitura dos alertas do BI para o Centro de Comando (a camada dashboards não importa o banco). Devolve, da empresa da sessão (RLS), os alertas que os
 * blocos usam: os ainda ativos (OPEN e ACKNOWLEDGED) e os abertos ou resolvidos dentro da janela [from, to). Cada linha traz o domínio da métrica (para o ABAC),
 * o owner da definição e a unidade do último valor. Só lê o schema analytics; nunca a tabela de origem de nenhum módulo.
 */
const { sequelize } = require('../../models');
const { ALERT_UNIT_LATERAL_SQL } = require('./alerts/alertUnit.sql');

async function listCommandAlerts({ companyId, from, to }, transaction) {
  const [rows] = await sequelize.query(
    `SELECT i.id, d.alert_code AS "alertCode", COALESCE(i.metric_code, d.metric_code) AS "metricCode", i.severity, i.status, i.opened_at AS "openedAt",
            i.acknowledged_at AS "acknowledgedAt", i.resolved_at AS "resolvedAt", d.owner_role AS "ownerRole", d.owner_user_id AS "ownerUserId",
            COALESCE(md.domain, 'GENERAL') AS domain, i.last_value::text AS "lastValue", u.unit
       FROM analytics.alert_instances i
       JOIN analytics.alert_definitions d ON d.id = i.alert_definition_id
       LEFT JOIN LATERAL (SELECT m.domain FROM analytics.metric_definitions m WHERE m.metric_code = COALESCE(i.metric_code, d.metric_code) AND m.status <> 'RETIRED'
                           ORDER BY (m.company_id IS NULL), (m.group_id IS NULL) LIMIT 1) md ON true
       ${ALERT_UNIT_LATERAL_SQL}
      WHERE i.company_id = :companyId
        AND (i.status IN ('OPEN', 'ACKNOWLEDGED') OR (i.opened_at >= :from AND i.opened_at < :to) OR (i.resolved_at >= :from AND i.resolved_at < :to))
      ORDER BY CASE i.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, i.opened_at, i.id`,
    { replacements: { companyId, from, to }, transaction }
  );
  return rows;
}

module.exports = { listCommandAlerts };
