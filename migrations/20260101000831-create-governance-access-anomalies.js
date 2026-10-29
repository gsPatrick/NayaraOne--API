'use strict';

/**
 * M9-D824 — governance.access_anomalies: a anomalia de acesso em massa detectada (kind READ ou EXPORT) com os sinais que a dispararam, a resposta dada ao IAM
 * (`restricted_until`, `mfa_forced_since`, `mfa_forced_until`) e a revisão humana (status OPEN, CONFIRMED ou FALSE_POSITIVE, com motivo). O índice único parcial
 * impede uma segunda anomalia ABERTA do mesmo usuário e tipo na empresa. RLS + FORCE, GRANT com guarda do role. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.access_anomalies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        user_id uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
        kind varchar(8) NOT NULL,
        status varchar(14) NOT NULL DEFAULT 'OPEN',
        window_minutes integer NOT NULL,
        trigger_signals jsonb NOT NULL,
        detected_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        restricted_until timestamptz NULL,
        mfa_forced_since timestamptz NULL,
        mfa_forced_until timestamptz NULL,
        reviewed_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        reviewed_at timestamptz NULL,
        review_reason text NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_accano_kind_chk CHECK (kind IN ('READ', 'EXPORT')),
        CONSTRAINT gov_accano_status_chk CHECK (status IN ('OPEN', 'CONFIRMED', 'FALSE_POSITIVE')),
        CONSTRAINT gov_accano_review_chk CHECK (status = 'OPEN' OR (reviewed_at IS NOT NULL AND review_reason IS NOT NULL))
      )`);
      await q("CREATE UNIQUE INDEX IF NOT EXISTS gov_accano_open_uq ON governance.access_anomalies (company_id, user_id, kind) WHERE status = 'OPEN'");
      await q('CREATE INDEX IF NOT EXISTS gov_accano_list_idx ON governance.access_anomalies (company_id, detected_at DESC)');
      await q("SELECT governance.apply_tenant_rls('governance.access_anomalies'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.access_anomalies');
  },
};
