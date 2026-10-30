'use strict';

/**
 * M9-D863 — governance.degradation_actions: cada passo de degradação aplicado por um orçamento num período. `previous_value` guarda o valor anterior para
 * a reversão; `status` APPLIED|REVERTED. Um passo só pode estar APPLIED uma vez por orçamento e período (índice único parcial = idempotência). Os passos
 * são os cinco interruptores de função do livro (CHECK); a tabela não tem como representar o desligamento de um recurso de infraestrutura.
 * RLS + FORCE pela empresa (função do alicerce, GRANT guardado).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.degradation_actions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        budget_id uuid NOT NULL REFERENCES governance.budgets(id) ON UPDATE CASCADE ON DELETE CASCADE,
        policy_id uuid NULL REFERENCES governance.degradation_policies(id) ON UPDATE CASCADE ON DELETE SET NULL,
        step varchar(40) NOT NULL,
        threshold smallint NOT NULL,
        period_start date NOT NULL,
        status varchar(8) NOT NULL DEFAULT 'APPLIED',
        applied_percent integer NOT NULL DEFAULT 0,
        trigger_event_id uuid NULL,
        previous_value jsonb NOT NULL DEFAULT '{}'::jsonb,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reverted_at timestamptz NULL,
        revert_reason varchar(20) NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_degradation_actions_step_chk CHECK (step IN ('SWITCH_AI_MODEL_CHEAPER', 'PAUSE_MARKETING_CAMPAIGNS', 'REDUCE_LOG_LEVEL', 'LIMIT_EXPORT_SIZE', 'DEFER_NON_CRITICAL_JOBS')),
        CONSTRAINT gov_degradation_actions_status_chk CHECK (status IN ('APPLIED', 'REVERTED')),
        CONSTRAINT gov_degradation_actions_threshold_chk CHECK (threshold IN (50, 75, 90, 100))
      )`);
      await q("CREATE UNIQUE INDEX IF NOT EXISTS gov_degradation_actions_applied_uq ON governance.degradation_actions (budget_id, period_start, step) WHERE status = 'APPLIED'");
      await q('CREATE INDEX IF NOT EXISTS gov_degradation_actions_active_idx ON governance.degradation_actions (company_id, step) WHERE status = \'APPLIED\'');
      await q("SELECT governance.apply_tenant_rls('governance.degradation_actions'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.degradation_actions');
  },
};
