'use strict';

/**
 * Marco 9, demanda M9-D687: seed idempotente dos 12 painéis do livro + command_center como definições GLOBAL PUBLISHED
 * (version 1) no schema analytics (tabelas da M9-D601). Primeiro widget de cada painel = faixa de qualidade (BI-015).
 * Rodar duas vezes não duplica (pula o código que já tem definição global). Escrita com app.analytics_writer = on (só nesta
 * transação). `required_permission` pode apontar para permissão criada por migration posterior (a 9700); a existência é
 * conferida na PUBLICAÇÃO pelo serviço, não aqui. down: remove só as definições globais deste seed.
 */
const { DASHBOARD_CATALOG, DASHBOARD_CODES, SEED_P95_MS } = require('../src/modules/analytics/dashboards/dashboard.catalog');

const ZERO_SCOPE = 'company_id IS NULL AND group_id IS NULL';

module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q("SELECT set_config('app.analytics_writer', 'on', true)");
      for (const panel of DASHBOARD_CATALOG) {
        const [exists] = await q(`SELECT 1 FROM analytics.dashboard_definitions WHERE dashboard_code = :code AND ${ZERO_SCOPE}`, { code: panel.code });
        if (exists.length) continue;
        const [[row]] = await q(
          `INSERT INTO analytics.dashboard_definitions
             (dashboard_code, name, description, domain, audience_roles, layout, status, version, p95_target_ms, required_permission)
           VALUES (:code, :name, :description, :domain, '[]'::jsonb, '{}'::jsonb, 'DRAFT', 1, :p95, :permission) RETURNING id`,
          {
            code: panel.code, name: panel.name, domain: panel.domain, p95: SEED_P95_MS, permission: panel.requiredPermission,
            description: `Painel ${panel.name} do catálogo do BI. O conteúdo vem da demanda ${panel.contentDemand}.`,
          }
        );
        for (const [position, widget] of panel.widgets.entries()) {
          await q(
            `INSERT INTO analytics.dashboard_widgets (dashboard_id, position, widget_type, title, value_nature, drilldown_enabled, config)
             VALUES (:id, :position, :type, :title, 'ACTUAL', false, '{}'::jsonb)`,
            { id: row.id, position, type: widget.widgetType, title: widget.title }
          );
        }
        await q("UPDATE analytics.dashboard_definitions SET status = 'PUBLISHED', published_at = now(), updated_at = now() WHERE id = :id", { id: row.id });
      }
    });
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q("SELECT set_config('app.analytics_writer', 'on', true)");
      await q('ALTER TABLE analytics.dashboard_widgets DISABLE TRIGGER dashboard_widgets_guard');
      await q('ALTER TABLE analytics.dashboard_definitions DISABLE TRIGGER dashboard_definitions_guard');
      try {
        const ids = `SELECT id FROM analytics.dashboard_definitions WHERE dashboard_code = ANY(ARRAY[:codes]) AND ${ZERO_SCOPE}`;
        await q(`DELETE FROM analytics.dashboard_widgets WHERE dashboard_id IN (${ids})`, { codes: DASHBOARD_CODES });
        await q(`DELETE FROM analytics.dashboard_definitions WHERE dashboard_code = ANY(ARRAY[:codes]) AND ${ZERO_SCOPE}`, { codes: DASHBOARD_CODES });
      } finally {
        await q('ALTER TABLE analytics.dashboard_widgets ENABLE TRIGGER dashboard_widgets_guard');
        await q('ALTER TABLE analytics.dashboard_definitions ENABLE TRIGGER dashboard_definitions_guard');
      }
    });
  },
};
