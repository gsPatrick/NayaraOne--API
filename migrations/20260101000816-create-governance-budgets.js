'use strict';

/**
 * M9-D861 — governance.budgets: orçamento mensal de custo por empresa, ambiente e domínio (ou PLATFORM). Valor em centavos inteiros e maior que zero;
 * o responsável (`owner_user_id`) recebe os avisos. Único por empresa + ambiente + domínio. RLS + FORCE pela empresa (função do alicerce, GRANT guardado).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.budgets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        environment varchar(8) NOT NULL,
        domain varchar(40) NOT NULL,
        period varchar(5) NOT NULL DEFAULT 'MONTH',
        amount_cents bigint NOT NULL,
        owner_user_id uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        created_by uuid NULL,
        updated_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_budgets_env_chk CHECK (environment IN ('PROD', 'HOMOLOG', 'DEV')),
        CONSTRAINT gov_budgets_period_chk CHECK (period = 'MONTH'),
        CONSTRAINT gov_budgets_amount_chk CHECK (amount_cents > 0),
        CONSTRAINT gov_budgets_scope_uq UNIQUE (company_id, environment, domain)
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.budgets'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.budgets');
  },
};
