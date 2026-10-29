'use strict';

/**
 * M9-D824 — governance.user_dlp_state: o estado de DLP do usuário na empresa que o IAM e o guard leem: `dlp_restricted_until` (EXPORT, SHARE e PRINT suspensos até
 * o instante), `mfa_step_up_forced_until` e `mfa_forced_since` (o MFA verificado ANTES de `mfa_forced_since` não vale enquanto `mfa_step_up_forced_until` não passar).
 * Uma linha por (empresa, usuário); recalculada a partir das anomalias abertas ou confirmadas. RLS + FORCE, GRANT com guarda do role. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.user_dlp_state (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        user_id uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
        dlp_restricted_until timestamptz NULL,
        mfa_step_up_forced_until timestamptz NULL,
        mfa_forced_since timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS gov_usrdlp_user_uq ON governance.user_dlp_state (company_id, user_id)');
      await q("SELECT governance.apply_tenant_rls('governance.user_dlp_state'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.user_dlp_state');
  },
};
