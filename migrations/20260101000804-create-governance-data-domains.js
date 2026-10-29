'use strict';

/**
 * M9-D804 — domínios de dados e designações de owner/steward. `data_domains` é o cadastro por empresa (semeado a partir do parâmetro
 * governanca.dados.dominios, e a linha serve de trava ao trocar o owner); `data_domain_assignments` guarda a vigência de cada
 * designação (valid_until nulo = vigente). Histórico nunca é apagado (gatilho recusa DELETE); um único OWNER vigente por domínio.
 * RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      const base = `id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,`;
      await q(`CREATE TABLE IF NOT EXISTS governance.data_domains (${base}
        code varchar(40) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_data_domains_code_uq UNIQUE (company_id, code),
        CONSTRAINT gov_data_domains_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_]*$')
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.data_domains'::regclass)");
      await q(`CREATE TABLE IF NOT EXISTS governance.data_domain_assignments (${base}
        domain_id uuid NOT NULL REFERENCES governance.data_domains(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        role varchar(10) NOT NULL,
        user_id uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        valid_from timestamptz NOT NULL DEFAULT now(),
        valid_until timestamptz NULL,
        designated_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        close_reason text NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_data_assign_role_chk CHECK (role IN ('OWNER', 'STEWARD')),
        CONSTRAINT gov_data_assign_period_chk CHECK (valid_until IS NULL OR valid_until >= valid_from)
      )`);
      await q("CREATE UNIQUE INDEX IF NOT EXISTS gov_data_assign_one_owner_idx ON governance.data_domain_assignments (domain_id) WHERE role = 'OWNER' AND valid_until IS NULL");
      await q('CREATE UNIQUE INDEX IF NOT EXISTS gov_data_assign_one_active_idx ON governance.data_domain_assignments (domain_id, role, user_id) WHERE valid_until IS NULL');
      await q('CREATE INDEX IF NOT EXISTS gov_data_assign_user_idx ON governance.data_domain_assignments (company_id, user_id) WHERE valid_until IS NULL');
      await q("SELECT governance.apply_tenant_rls('governance.data_domain_assignments'::regclass)");
      await q(`CREATE OR REPLACE FUNCTION governance.refuse_assignment_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN RAISE EXCEPTION 'O histórico de designações de dados não pode ser apagado.' USING ERRCODE = '23001'; END $fn$`);
      await q('DROP TRIGGER IF EXISTS gov_data_assign_no_delete ON governance.data_domain_assignments');
      await q('CREATE TRIGGER gov_data_assign_no_delete BEFORE DELETE ON governance.data_domain_assignments FOR EACH ROW EXECUTE FUNCTION governance.refuse_assignment_delete()');
    });
  },
  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP TABLE IF EXISTS governance.data_domain_assignments', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS governance.data_domains', { transaction });
      await sequelize.query('DROP FUNCTION IF EXISTS governance.refuse_assignment_delete()', { transaction });
    });
  },
};
