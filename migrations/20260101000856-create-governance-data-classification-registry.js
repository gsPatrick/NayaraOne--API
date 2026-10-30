'use strict';

/**
 * M9-D910 — governance.data_classification_registry: o inventário oficial de cada coluna de negócio (schema, tabela, coluna) com os 7 atributos do livro: classification,
 * purpose, retention_policy (retention_policy_id, obrigatório), masking (+ mask_pattern), exportability, ai_allowed e owner (owner_domain, resolvido para o data owner
 * vigente do domínio, M9-D804). Uma linha por (empresa, coluna). `source` diz se a linha veio da regra automática (AUTO) ou de ajuste do steward (MANUAL). RLS + FORCE
 * pela função do alicerce (M9-D800). Reversível.
 */
const list = (items) => items.map((item) => `'${item}'`).join(', ');

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.data_classification_registry (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        schema_name varchar(63) NOT NULL,
        table_name varchar(63) NOT NULL,
        column_name varchar(63) NOT NULL,
        entity varchar(120) NOT NULL,
        classification varchar(10) NOT NULL,
        purpose varchar(20) NOT NULL,
        retention_policy_id uuid NOT NULL REFERENCES governance.retention_policies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        masking varchar(10) NOT NULL,
        mask_pattern varchar(80) NULL,
        exportability varchar(15) NOT NULL,
        ai_allowed boolean NOT NULL,
        owner_domain varchar(40) NOT NULL,
        source varchar(6) NOT NULL DEFAULT 'AUTO',
        version integer NOT NULL DEFAULT 1,
        updated_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_dcr_column_uq UNIQUE (company_id, schema_name, table_name, column_name),
        CONSTRAINT gov_dcr_class_chk CHECK (classification IN (${list(['LOW', 'MEDIUM', 'HIGH', 'RESTRICTED'])})),
        CONSTRAINT gov_dcr_purpose_chk CHECK (purpose IN (${list(['CONTRATO', 'COBRANCA', 'OBRIGACAO_LEGAL', 'ATENDIMENTO', 'MARKETING', 'SEGURANCA', 'OPERACAO_INTERNA', 'ANALISE'])})),
        CONSTRAINT gov_dcr_masking_chk CHECK (masking IN (${list(['NONE', 'PARTIAL', 'FULL', 'HASH', 'TOKENIZE'])})),
        CONSTRAINT gov_dcr_export_chk CHECK (exportability IN (${list(['ALLOWED', 'ALLOWED_MASKED', 'WITH_APPROVAL', 'FORBIDDEN'])})),
        CONSTRAINT gov_dcr_source_chk CHECK (source IN ('AUTO', 'MANUAL')),
        CONSTRAINT gov_dcr_owner_chk CHECK (owner_domain ~ '^[A-Z][A-Z0-9_]*$')
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_dcr_class_idx ON governance.data_classification_registry (company_id, classification, schema_name, table_name)');
      await q('CREATE INDEX IF NOT EXISTS gov_dcr_policy_idx ON governance.data_classification_registry (retention_policy_id)');
      await q("SELECT governance.apply_tenant_rls('governance.data_classification_registry'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.data_classification_registry');
  },
};
