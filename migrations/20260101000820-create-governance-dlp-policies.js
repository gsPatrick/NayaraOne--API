'use strict';

/**
 * M9-D820 — governance.dlp_policies: a política de DLP por empresa, uma linha por (classificação, ação) com as seis ações (VIEW, COPY, EXPORT, PRINT, SHARE, AI)
 * e as quatro classes (LOW a RESTRICTED). As 24 linhas nascem sob demanda, a partir da matriz padrão e dos parâmetros governanca.dlp.* (o serviço semeia na
 * primeira leitura). RLS + FORCE pela função do alicerce (M9-D800), GRANT ao role de runtime dentro da guarda de existência. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.dlp_policies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        classification varchar(12) NOT NULL,
        action varchar(8) NOT NULL,
        allowed boolean NOT NULL DEFAULT true,
        require_permission varchar(100) NULL,
        require_justification boolean NOT NULL DEFAULT false,
        require_mfa boolean NOT NULL DEFAULT false,
        require_audit boolean NOT NULL DEFAULT false,
        require_watermark boolean NOT NULL DEFAULT false,
        require_mask boolean NOT NULL DEFAULT false,
        max_rows integer NULL,
        max_expiry_hours integer NULL,
        updated_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_dlp_pol_class_chk CHECK (classification IN ('LOW', 'MEDIUM', 'HIGH', 'RESTRICTED')),
        CONSTRAINT gov_dlp_pol_action_chk CHECK (action IN ('VIEW', 'COPY', 'EXPORT', 'PRINT', 'SHARE', 'AI')),
        CONSTRAINT gov_dlp_pol_rows_chk CHECK (max_rows IS NULL OR max_rows >= 1),
        CONSTRAINT gov_dlp_pol_expiry_chk CHECK (max_expiry_hours IS NULL OR max_expiry_hours >= 1)
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS gov_dlp_pol_key_uq ON governance.dlp_policies (company_id, classification, action)');
      await q("SELECT governance.apply_tenant_rls('governance.dlp_policies'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.dlp_policies');
  },
};
