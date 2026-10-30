'use strict';

/**
 * M9-D860 — governance.cost_read_model (agregado por dia, ambiente, domínio, categoria e tipo; ESTIMATED e BILLED em linhas separadas, nunca somadas;
 * não conta linha substituída) e governance.cost_accruals (acúmulo de uso por hora antes de virar linha do ledger: o custo da chamada de IA vale
 * frações de centavo, então soma-se em `cost_scaled` = centavos x 1.000.000 e só se arredonda, half-even, ao fechar a hora).
 * RLS + FORCE: o read model pelo grupo (empresa opcional, como o ledger); o acúmulo pela empresa.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.cost_read_model (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        day date NOT NULL,
        environment varchar(8) NOT NULL,
        domain varchar(40) NOT NULL,
        category varchar(14) NOT NULL,
        cost_kind varchar(9) NOT NULL,
        amount_cents bigint NOT NULL,
        line_count integer NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_cost_rm_kind_chk CHECK (cost_kind IN ('ESTIMATED', 'BILLED'))
      )`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS gov_cost_rm_key_uq ON governance.cost_read_model
        (group_id, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), day, environment, domain, category, cost_kind)`);
      await q("SELECT governance.apply_group_rls('governance.cost_read_model'::regclass)");

      await q(`CREATE TABLE IF NOT EXISTS governance.cost_accruals (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        environment varchar(8) NOT NULL,
        domain varchar(40) NOT NULL,
        category varchar(14) NOT NULL,
        service varchar(120) NOT NULL,
        hour_start timestamptz NOT NULL,
        usage_quantity numeric(30,6) NOT NULL DEFAULT 0,
        usage_unit varchar(20) NOT NULL,
        calls bigint NOT NULL DEFAULT 0,
        tokens_in bigint NOT NULL DEFAULT 0,
        tokens_out bigint NOT NULL DEFAULT 0,
        cost_scaled numeric(40,0) NOT NULL DEFAULT 0,
        consolidated_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_cost_accr_cat_chk CHECK (category IN ('AI', 'EGRESS', 'MESSAGING')),
        CONSTRAINT gov_cost_accr_key_uq UNIQUE (company_id, environment, domain, category, service, hour_start)
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.cost_accruals'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.cost_accruals');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.cost_read_model');
  },
};
