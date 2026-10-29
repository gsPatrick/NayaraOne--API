'use strict';

/**
 * M9-D014 — ai.budget_alerts: um alerta por limiar e período de cada orçamento. UNIQUE (budget_id, threshold, period_start)
 * garante que o limiar cruzado por duas conexões ao mesmo tempo gera uma só linha (e, portanto, um só evento
 * ai.budget.threshold_reached). Registro imutável (só INSERT e SELECT). RLS ENABLE + FORCE por empresa.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS ai.budget_alerts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        budget_id uuid NOT NULL REFERENCES ai.budgets(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        threshold integer NOT NULL,
        consumed_pct numeric(9,2) NOT NULL,
        consumed_amount numeric(18,6) NOT NULL,
        limit_amount numeric(18,2) NOT NULL,
        period_start timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT budget_alerts_threshold_chk CHECK (threshold BETWEEN 1 AND 1000),
        CONSTRAINT budget_alerts_unique UNIQUE (budget_id, threshold, period_start)
      )`);
      await q('CREATE INDEX IF NOT EXISTS ai_budget_alerts_company_idx ON ai.budget_alerts (company_id, created_at)');
      await q('ALTER TABLE ai.budget_alerts ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE ai.budget_alerts FORCE ROW LEVEL SECURITY');
      await q('DROP POLICY IF EXISTS tenant_isolation ON ai.budget_alerts');
      await q(`CREATE POLICY tenant_isolation ON ai.budget_alerts
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
               AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT USAGE ON SCHEMA ai TO nayara_runtime;
            GRANT SELECT, INSERT ON ai.budget_alerts TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM ai.budget_alerts', { transaction });
      if (n > 0) throw new Error('ai.budget_alerts tem alertas gravados (registro de auditoria); apague-os de propósito antes de reverter a migration.');
      await sequelize.query('DROP TABLE IF EXISTS ai.budget_alerts', { transaction });
    });
  },
};
