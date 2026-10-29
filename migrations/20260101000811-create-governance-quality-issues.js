'use strict';

/**
 * M9-D806 — governance.quality_issues: um problema de qualidade por regra reprovada. UNIQUE (empresa, entidade, cadastro, regra) enquanto OPEN: a mesma
 * avaliação repetida não duplica a issue. Corrigido o dado, a issue vira RESOLVED na avaliação seguinte; se reprovar de novo, abre uma nova.
 * RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.quality_issues (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        entity_type varchar(20) NOT NULL,
        entity_id uuid NOT NULL,
        rule_code varchar(60) NOT NULL,
        severity varchar(10) NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'OPEN',
        opened_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at timestamptz NULL,
        assigned_steward_id uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_qissues_entity_chk CHECK (entity_type IN ('PERSON', 'PROPERTY', 'SUPPLIER')),
        CONSTRAINT gov_qissues_severity_chk CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        CONSTRAINT gov_qissues_status_chk CHECK (status IN ('OPEN', 'RESOLVED')),
        CONSTRAINT gov_qissues_resolved_chk CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL))
      )`);
      await q("CREATE UNIQUE INDEX IF NOT EXISTS gov_qissues_open_uq ON governance.quality_issues (company_id, entity_type, entity_id, rule_code) WHERE status = 'OPEN'");
      await q('CREATE INDEX IF NOT EXISTS gov_qissues_list_idx ON governance.quality_issues (company_id, status, severity, entity_type, opened_at DESC)');
      await q("SELECT governance.apply_tenant_rls('governance.quality_issues'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.quality_issues');
  },
};
