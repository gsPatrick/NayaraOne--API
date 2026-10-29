'use strict';

/**
 * M9-D831 — governance.manual_operations: a operação feita no papel durante a indisponibilidade (formulário contingencial numerado). `manual_reference` é o número impresso
 * (`<PREFIXO>-<AAAA>-<nnnnn>`), único por empresa: é a ponte entre o papel e a importação (M9-D832). O registro guarda só a INTENÇÃO (`intended_action`, `payload`); o efeito
 * de negócio é da importação. `validation_errors` é vazio quando o payload é válido; payload inválido fica RECORDED com o erro gravado (nunca recusado, o papel já existe).
 * REJECTED só nasce da decisão humana de estornar e é final. RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.manual_operations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        manual_reference varchar(20) NOT NULL,
        sector varchar(20) NOT NULL REFERENCES governance.bcp_sectors(sector) ON UPDATE CASCADE ON DELETE RESTRICT,
        occurred_at timestamptz NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        actor_user_id uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        evidence_file_id uuid NOT NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        intended_action varchar(40) NOT NULL,
        form_type varchar(40) NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        correlation_ref uuid NOT NULL,
        validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
        last_error text NULL,
        last_error_at timestamptz NULL,
        status varchar(12) NOT NULL DEFAULT 'RECORDED',
        import_command_ref varchar(200) NULL,
        reject_reason text NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_manual_op_status_chk CHECK (status IN ('RECORDED', 'IMPORTED', 'REJECTED', 'RECONCILED')),
        CONSTRAINT gov_manual_op_ref_uq UNIQUE (company_id, manual_reference)
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_manual_op_corr_idx ON governance.manual_operations (company_id, correlation_ref)');
      await q('CREATE INDEX IF NOT EXISTS gov_manual_op_list_idx ON governance.manual_operations (company_id, status, sector, recorded_at DESC)');
      await q("SELECT governance.apply_tenant_rls('governance.manual_operations'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.manual_operations');
  },
};
