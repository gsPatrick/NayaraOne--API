'use strict';

/**
 * Marco 9, demanda M9-D712: classificação explícita das métricas do BI e semente do registry.
 *  1. analytics.metric_definitions.criticality perde o valor padrão (a classificação é sempre explícita) e ganha drilldown_enabled
 *     (CHECK: métrica CRITICAL tem drill-down ligado; definições já existentes classificadas CRITICAL são ajustadas antes).
 *  2. Semente idempotente por metric_code no catálogo GLOBAL: as 90 definições da tabela de criticidade, com criticidade e drill-down
 *     da tabela. A versão 1 PUBLISHED de cada uma nasce quando a demanda do KPI entrega a fórmula (e o read model existe):
 *     scripts/analytics/seedMetricRegistry.js repete a semente e publica o que já estiver pronto.
 * down: remove só as definições globais DRAFT desta semente e restaura o estado anterior da coluna.
 */
const { ensureDefinitions } = require('../src/features/analytics/metrics/seed/seed.definitions');
const { listCriticalityRows } = require('../src/features/analytics/metrics/seed/criticality.table');

module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q('ALTER TABLE analytics.metric_definitions ADD COLUMN IF NOT EXISTS drilldown_enabled boolean NOT NULL DEFAULT false');
      await q("UPDATE analytics.metric_definitions SET drilldown_enabled = true WHERE criticality = 'CRITICAL' AND NOT drilldown_enabled");
      await q('ALTER TABLE analytics.metric_definitions ALTER COLUMN criticality DROP DEFAULT');
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'metric_definitions_critical_drilldown') THEN
          ALTER TABLE analytics.metric_definitions ADD CONSTRAINT metric_definitions_critical_drilldown CHECK (criticality <> 'CRITICAL' OR drilldown_enabled);
        END IF; END $$`);
      await ensureDefinitions(async (sql, replacements) => (await q(sql, replacements))[0]);
    });
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q("SELECT set_config('app.analytics_writer', 'on', true)");
      await q('ALTER TABLE analytics.metric_definitions DROP CONSTRAINT IF EXISTS metric_definitions_critical_drilldown');
      await q(
        "DELETE FROM analytics.metric_definitions WHERE company_id IS NULL AND group_id IS NULL AND status = 'DRAFT' AND current_version_id IS NULL AND metric_code = ANY(ARRAY[:codes])",
        { codes: listCriticalityRows().map((r) => r.code) }
      );
      await q("ALTER TABLE analytics.metric_definitions ALTER COLUMN criticality SET DEFAULT 'NORMAL'");
      await q('ALTER TABLE analytics.metric_definitions DROP COLUMN IF EXISTS drilldown_enabled');
    });
  },
};
