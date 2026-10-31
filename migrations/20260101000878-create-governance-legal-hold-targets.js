'use strict';

/**
 * M9-D912 — governance.legal_hold_targets: o escopo da retenção legal materializado (uma linha por registro protegido) para a consulta rápida da trava. `entity_id` '*' protege
 * todos os registros do tipo (escopo por tipo de dado sem período) e o tipo COMPANY protege a empresa inteira. Os registros que passam a cair no escopo depois da criação (ex.: o
 * contrato novo de uma pessoa em hold) entram pelo serviço, na checagem. A linha some junto com a retenção (CASCADE) e, enquanto a retenção é liberada, deixa de valer.
 * RLS + FORCE (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.legal_hold_targets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        hold_id uuid NOT NULL REFERENCES governance.legal_holds(id) ON UPDATE CASCADE ON DELETE CASCADE,
        entity_type varchar(24) NOT NULL,
        entity_id varchar(64) NOT NULL,
        origin varchar(10) NOT NULL DEFAULT 'EXPLICIT',
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_hold_target_uq UNIQUE (hold_id, entity_type, entity_id),
        CONSTRAINT gov_hold_target_type_chk CHECK (entity_type IN ('COMPANY', 'PERSON', 'PROPERTY', 'CONTRACT', 'LEGAL_CASE', 'FISCAL_OBLIGATION', 'TAX_DOCUMENT', 'FILE', 'ACCESS_SIGNAL', 'AUDIT_LOG', 'INTEGRATION')),
        CONSTRAINT gov_hold_target_origin_chk CHECK (origin IN ('EXPLICIT', 'DERIVED'))
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_hold_target_lookup_idx ON governance.legal_hold_targets (company_id, entity_type, entity_id)');
      await q("SELECT governance.apply_tenant_rls('governance.legal_hold_targets'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.legal_hold_targets');
  },
};
