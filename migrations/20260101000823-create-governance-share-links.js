'use strict';

/**
 * M9-D823 — governance.share_links: o link externo temporário e revogável de um recurso. O token (32 bytes aleatórios, base64url) NUNCA é guardado: só o hash SHA-256
 * (`token_hash`, único). O pedido auditado é um governance.export_jobs com kind SHARE (`export_job_id`); revogar ou expirar muda os dois na mesma transação.
 * RLS + FORCE pela função do alicerce (M9-D800), com uma SEGUNDA política só de leitura: a rota pública /public/share/:token ainda não sabe a empresa, então resolve pelo
 * hash — a política deixa ver só a linha cujo hash é igual ao `app.share_token_hash` da transação (consulta restrita ao hash, sem função de serviço). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.share_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        created_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        resource_type varchar(80) NOT NULL,
        resource_id uuid NOT NULL,
        recipient_label varchar(200) NOT NULL,
        classification varchar(12) NULL,
        token_hash varchar(64) NOT NULL,
        expires_at timestamptz NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'ACTIVE',
        revoked_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        revoked_at timestamptz NULL,
        export_job_id uuid NOT NULL REFERENCES governance.export_jobs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        watermark boolean NOT NULL DEFAULT false,
        access_count integer NOT NULL DEFAULT 0,
        last_accessed_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_share_status_chk CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED')),
        CONSTRAINT gov_share_class_chk CHECK (classification IS NULL OR classification IN ('LOW', 'MEDIUM', 'HIGH', 'RESTRICTED')),
        CONSTRAINT gov_share_revoked_chk CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS gov_share_token_uq ON governance.share_links (token_hash)');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS gov_share_job_uq ON governance.share_links (export_job_id)');
      await q('CREATE INDEX IF NOT EXISTS gov_share_list_idx ON governance.share_links (company_id, created_at DESC)');
      await q("CREATE INDEX IF NOT EXISTS gov_share_active_idx ON governance.share_links (company_id, expires_at) WHERE status = 'ACTIVE'");
      await q("SELECT governance.apply_tenant_rls('governance.share_links'::regclass)");
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'governance.share_links'::regclass AND polname = 'share_token_lookup') THEN
          CREATE POLICY share_token_lookup ON governance.share_links FOR SELECT USING (token_hash = NULLIF(current_setting('app.share_token_hash', true), ''));
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.share_links');
  },
};
