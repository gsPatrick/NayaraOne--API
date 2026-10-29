'use strict';

/**
 * M9-D806 — governance.quality_rules: regras de qualidade de cadastro por empresa (completude e consistência). `expression` e `applies_when` são
 * NOMES de verificação implementada em código, nunca SQL livre. O catálogo padrão é semeado por empresa na primeira avaliação (pesos, severidade e
 * regras desligadas vêm dos parâmetros governanca.dados.qualidade.*). RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.quality_rules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        code varchar(60) NOT NULL,
        entity_type varchar(20) NOT NULL,
        dimension varchar(20) NOT NULL,
        severity varchar(10) NOT NULL,
        weight integer NOT NULL,
        expression varchar(60) NOT NULL,
        applies_when varchar(60) NULL,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_qrules_entity_chk CHECK (entity_type IN ('PERSON', 'PROPERTY', 'SUPPLIER')),
        CONSTRAINT gov_qrules_dimension_chk CHECK (dimension IN ('COMPLETENESS', 'CONSISTENCY')),
        CONSTRAINT gov_qrules_severity_chk CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        CONSTRAINT gov_qrules_weight_chk CHECK (weight >= 0 AND weight <= 1000)
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS gov_qrules_code_uq ON governance.quality_rules (company_id, code)');
      await q("SELECT governance.apply_tenant_rls('governance.quality_rules'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.quality_rules');
  },
};
