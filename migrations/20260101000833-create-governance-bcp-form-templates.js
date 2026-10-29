'use strict';

/**
 * M9-D834 — governance.bcp_form_templates: o modelo dos 11 formulários contingenciais dos seis setores (campos, tipo, obrigatoriedade e `payload_schema`). É catálogo do sistema,
 * igual para toda empresa (sem company_id, como governance.bcp_sectors; DI-D834-1): RLS + FORCE com uma política só de leitura; o role de runtime recebe apenas SELECT
 * (GRANT dentro de guarda de existência). Semeada com os 11 formulários da tabela 3.2 (UNIQUE (sector, form_type); a ação pretendida é única por tipo). Reversível.
 */
const { FORMS } = require('../src/features/core-governance/bcp/bcp.forms.constants');
const { toTemplateRow } = require('../src/features/core-governance/bcp/bcp.schema');

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q(`CREATE TABLE IF NOT EXISTS governance.bcp_form_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        sector varchar(20) NOT NULL REFERENCES governance.bcp_sectors(sector) ON UPDATE CASCADE ON DELETE RESTRICT,
        form_type varchar(40) NOT NULL,
        title varchar(80) NOT NULL,
        intended_action varchar(40) NOT NULL,
        fields jsonb NOT NULL,
        payload_schema jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_bcp_form_sector_type_uq UNIQUE (sector, form_type),
        CONSTRAINT gov_bcp_form_type_uq UNIQUE (form_type),
        CONSTRAINT gov_bcp_form_action_uq UNIQUE (intended_action)
      )`);
      for (const form of FORMS) {
        const row = toTemplateRow(form);
        await q(`INSERT INTO governance.bcp_form_templates (sector, form_type, title, intended_action, fields, payload_schema)
          VALUES (:sector, :form_type, :title, :intended_action, CAST(:fields AS jsonb), CAST(:payload_schema AS jsonb)) ON CONFLICT (sector, form_type) DO NOTHING`,
        { ...row, fields: JSON.stringify(row.fields), payload_schema: JSON.stringify(row.payload_schema) });
      }
      await q('ALTER TABLE governance.bcp_form_templates ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE governance.bcp_form_templates FORCE ROW LEVEL SECURITY');
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'governance.bcp_form_templates'::regclass AND polname = 'bcp_form_templates_read') THEN
          CREATE POLICY bcp_form_templates_read ON governance.bcp_form_templates FOR SELECT USING (true);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT ON governance.bcp_form_templates TO nayara_runtime;
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.bcp_form_templates');
  },
};
