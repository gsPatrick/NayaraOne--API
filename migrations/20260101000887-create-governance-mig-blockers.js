'use strict';

/**
 * M9-D901 — governance.mig_blockers: condições abertas que impedem o corte (código, entidade, referência, dono, detalhe e `since`, o instante em que abriram). Um blocker aberto por
 * (empresa, código, entidade, referência): índice único parcial em closed_at IS NULL. Fechar preenche closed_at; o histórico fica. RLS + FORCE. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.mig_blockers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        code varchar(60) NOT NULL,
        entity varchar(30) NULL,
        ref varchar(128) NOT NULL DEFAULT '',
        owner text NULL,
        detail jsonb NOT NULL DEFAULT '{}'::jsonb,
        since timestamptz NOT NULL DEFAULT now(),
        closed_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS mig_blockers_open_uq ON governance.mig_blockers (company_id, code, COALESCE(entity, \'\'), ref) WHERE closed_at IS NULL');
      await q('CREATE INDEX IF NOT EXISTS mig_blockers_company_idx ON governance.mig_blockers (company_id, closed_at)');
      await q("SELECT governance.apply_tenant_rls('governance.mig_blockers'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.mig_blockers');
  },
};
