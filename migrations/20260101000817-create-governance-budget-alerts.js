'use strict';

/**
 * M9-D861 — governance.budget_alerts: um registro por limiar (50, 75, 90, 100) disparado, por orçamento e mês. A UNIQUE (budget_id, period_start, threshold)
 * é a trava de idempotência: o mesmo limiar nunca dispara duas vezes no período, nem com duas avaliações ao mesmo tempo. `seq` guarda a ordem de disparo.
 * Guarda o que foi visto no disparo (percentual, consumo, orçamento e a série usada). Mês novo = `period_start` novo = alertas reiniciados. RLS + FORCE pela empresa.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.budget_alerts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        seq bigint GENERATED ALWAYS AS IDENTITY,
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        budget_id uuid NOT NULL REFERENCES governance.budgets(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        period_start date NOT NULL,
        threshold smallint NOT NULL,
        percent integer NOT NULL,
        consumed_cents bigint NOT NULL,
        budget_cents bigint NOT NULL,
        series varchar(9) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_budget_alerts_threshold_chk CHECK (threshold IN (50, 75, 90, 100)),
        CONSTRAINT gov_budget_alerts_series_chk CHECK (series IN ('ESTIMATED', 'BILLED')),
        CONSTRAINT gov_budget_alerts_key_uq UNIQUE (budget_id, period_start, threshold)
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.budget_alerts'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.budget_alerts');
  },
};
