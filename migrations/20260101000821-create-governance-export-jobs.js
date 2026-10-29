'use strict';

/**
 * M9-D821 — governance.export_jobs: o pedido de tirar dado do sistema (exportar, compartilhar, imprimir, baixar) decidido pelo guard de DLP. Todo pedido grava uma
 * linha ANTES de qualquer avaliação, inclusive o bloqueado (status BLOCKED com block_reason e o rastro das 6 etapas em decision_trace); a linha nunca some.
 * `idempotency_key` é única por empresa (mesma chave devolve o mesmo pedido) e `request_hash` recusa a mesma chave com outro corpo. RLS + FORCE pela função do
 * alicerce (M9-D800), GRANT ao role de runtime com guarda de existência. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.export_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        actor_user_id uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        kind varchar(10) NOT NULL,
        action varchar(8) NOT NULL,
        resource_type varchar(80) NOT NULL,
        resource_ref jsonb NULL,
        classification varchar(12) NULL,
        purpose varchar(40) NULL,
        justification text NULL,
        estimated_rows integer NULL,
        status varchar(12) NOT NULL DEFAULT 'REQUESTED',
        block_reason varchar(12) NULL,
        decision_trace jsonb NULL,
        obligations jsonb NULL,
        expires_at timestamptz NULL,
        correlation_id varchar(100) NULL,
        idempotency_key varchar(128) NULL,
        request_hash varchar(64) NULL,
        requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        decided_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_expjob_kind_chk CHECK (kind IN ('EXPORT', 'SHARE', 'PRINT', 'DOWNLOAD')),
        CONSTRAINT gov_expjob_action_chk CHECK (action IN ('VIEW', 'COPY', 'EXPORT', 'PRINT', 'SHARE', 'AI')),
        CONSTRAINT gov_expjob_class_chk CHECK (classification IS NULL OR classification IN ('LOW', 'MEDIUM', 'HIGH', 'RESTRICTED')),
        CONSTRAINT gov_expjob_status_chk CHECK (status IN ('REQUESTED', 'BLOCKED', 'APPROVED', 'GENERATING', 'READY', 'EXPIRED', 'REVOKED', 'FAILED')),
        CONSTRAINT gov_expjob_reason_chk CHECK (block_reason IS NULL OR block_reason IN ('POLICY', 'SUSPENDED', 'PERMISSION', 'PURPOSE', 'MFA', 'VOLUME')),
        CONSTRAINT gov_expjob_blocked_chk CHECK ((status = 'BLOCKED') = (block_reason IS NOT NULL))
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS gov_expjob_key_uq ON governance.export_jobs (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
      await q('CREATE INDEX IF NOT EXISTS gov_expjob_list_idx ON governance.export_jobs (company_id, requested_at DESC)');
      await q("SELECT governance.apply_tenant_rls('governance.export_jobs'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.export_jobs');
  },
};
