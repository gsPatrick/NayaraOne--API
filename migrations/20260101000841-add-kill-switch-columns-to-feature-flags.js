'use strict';

/**
 * M9-D872 — kill switch no registro de flags: `probe` (nome da verificação automatizada registrada no código que prova que a função parou) e `verification_state`
 * (PENDING = nunca testado, VERIFIED = último teste PASS, UNVERIFIED = último teste FAIL). Só a tabela das flags booleanas (o kill switch é sempre uma flag). Amplia também
 * os tipos de alerta de governance.flag_alert_log (M9-D871) para o kill switch. A regra de que todo kill switch tem probe e risco CRITICAL vale para os novos (NOT VALID: não reprova linhas antigas). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE governance.feature_flags ADD COLUMN IF NOT EXISTS probe varchar(128) NULL');
      await q("ALTER TABLE governance.feature_flags ADD COLUMN IF NOT EXISTS verification_state varchar(12) NOT NULL DEFAULT 'PENDING'");
      await q('ALTER TABLE governance.feature_flags DROP CONSTRAINT IF EXISTS gov_feature_flags_verification_chk');
      await q("ALTER TABLE governance.feature_flags ADD CONSTRAINT gov_feature_flags_verification_chk CHECK (verification_state IN ('PENDING','VERIFIED','UNVERIFIED'))");
      await q('ALTER TABLE governance.feature_flags DROP CONSTRAINT IF EXISTS gov_feature_flags_kill_probe_chk');
      await q('ALTER TABLE governance.feature_flags ADD CONSTRAINT gov_feature_flags_kill_probe_chk CHECK (is_kill_switch = false OR (probe IS NOT NULL AND risk = \'CRITICAL\')) NOT VALID');
      await q('ALTER TABLE governance.flag_alert_log DROP CONSTRAINT IF EXISTS gov_flag_alert_log_type_chk');
      await q("ALTER TABLE governance.flag_alert_log ADD CONSTRAINT gov_flag_alert_log_type_chk CHECK (alert_type IN ('FLAG_EXPIRED', 'KILL_SWITCH_STALE', 'KILL_SWITCH_FAILED', 'KILL_DRILL_REFUSED'))");
    });
  },
  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE governance.feature_flags DROP CONSTRAINT IF EXISTS gov_feature_flags_kill_probe_chk');
      await q('ALTER TABLE governance.feature_flags DROP CONSTRAINT IF EXISTS gov_feature_flags_verification_chk');
      await q('ALTER TABLE governance.feature_flags DROP COLUMN IF EXISTS verification_state');
      await q('ALTER TABLE governance.feature_flags DROP COLUMN IF EXISTS probe');
      await q('ALTER TABLE governance.flag_alert_log DROP CONSTRAINT IF EXISTS gov_flag_alert_log_type_chk');
      await q("ALTER TABLE governance.flag_alert_log ADD CONSTRAINT gov_flag_alert_log_type_chk CHECK (alert_type IN ('FLAG_EXPIRED', 'KILL_SWITCH_STALE', 'KILL_SWITCH_FAILED'))");
    });
  },
};
