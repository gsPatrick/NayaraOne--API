'use strict';

/**
 * M9-D014 — ai.budgets: orçamento de uso da NAY por empresa, agente (NULL = todos) e classe de modelo (NULL = todas), por
 * período (MONTH, de 00:00 de America/Sao_Paulo do dia 1 ao dia 1 seguinte; period_end exclusivo). limit_amount em BRL com
 * duas casas; consumed_amount e reserved_amount com seis. thresholds e action_at_100 NULOS seguem os parâmetros da empresa
 * (ia.orcamento.limiares e ia.orcamento.acao_ao_100); preenchidos, valem para a linha. UNIQUE por escopo e período.
 * RLS ENABLE + FORCE por empresa; GRANT ao nayara_runtime só se o role existir; sem DELETE (o orçamento é registro financeiro).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('CREATE SCHEMA IF NOT EXISTS ai');
      await q(`CREATE TABLE IF NOT EXISTS ai.budgets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        agent_code varchar(80) NULL,
        model_class varchar(12) NULL,
        period varchar(8) NOT NULL DEFAULT 'MONTH',
        limit_amount numeric(18,2) NOT NULL,
        consumed_amount numeric(18,6) NOT NULL DEFAULT 0,
        reserved_amount numeric(18,6) NOT NULL DEFAULT 0,
        thresholds jsonb NULL,
        action_at_100 varchar(8) NULL,
        status varchar(8) NOT NULL DEFAULT 'ACTIVE',
        period_start timestamptz NOT NULL,
        period_end timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by uuid NULL,
        updated_by uuid NULL,
        CONSTRAINT budgets_agent_chk CHECK (agent_code IS NULL OR agent_code ~ '^[A-Z0-9_]{2,80}$'),
        CONSTRAINT budgets_model_class_chk CHECK (model_class IS NULL OR model_class IN ('SMALL', 'ADVANCED', 'EMBEDDING')),
        CONSTRAINT budgets_period_chk CHECK (period IN ('MONTH')),
        CONSTRAINT budgets_limit_chk CHECK (limit_amount > 0),
        CONSTRAINT budgets_consumed_chk CHECK (consumed_amount >= 0),
        CONSTRAINT budgets_reserved_chk CHECK (reserved_amount >= 0),
        CONSTRAINT budgets_thresholds_chk CHECK (thresholds IS NULL OR (jsonb_typeof(thresholds) = 'array' AND jsonb_array_length(thresholds) BETWEEN 1 AND 10)),
        CONSTRAINT budgets_action_chk CHECK (action_at_100 IS NULL OR action_at_100 IN ('BLOCK', 'DEGRADE')),
        CONSTRAINT budgets_status_chk CHECK (status IN ('ACTIVE', 'PAUSED')),
        CONSTRAINT budgets_period_range_chk CHECK (period_end > period_start)
      )`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS ai_budgets_scope_uq
        ON ai.budgets (company_id, COALESCE(agent_code, ''), COALESCE(model_class, ''), period_start)`);
      await q('CREATE INDEX IF NOT EXISTS ai_budgets_company_period_idx ON ai.budgets (company_id, period_start, period_end)');
      await q('ALTER TABLE ai.budgets ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE ai.budgets FORCE ROW LEVEL SECURITY');
      await q('DROP POLICY IF EXISTS tenant_isolation ON ai.budgets');
      await q(`CREATE POLICY tenant_isolation ON ai.budgets
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
               AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT USAGE ON SCHEMA ai TO nayara_runtime;
            GRANT SELECT, INSERT, UPDATE ON ai.budgets TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM ai.budgets', { transaction });
      if (n > 0) throw new Error('ai.budgets tem orçamentos gravados (registro financeiro); apague-os de propósito antes de reverter a migration.');
      await sequelize.query('DROP TABLE IF EXISTS ai.budgets', { transaction });
    });
  },
};
