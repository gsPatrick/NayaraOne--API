'use strict';

/**
 * M9-D871 — governance.flag_alert_log: registro dos alertas do registro de flags (flag temporária vencida; reaproveitado pelo kill switch na M9-D872). A chave de deduplicação
 * (`flag.expired:<chave>:<AAAA-MM-DD>`) é UNIQUE por empresa: o mesmo alerta nunca é criado duas vezes no dia, nem com dois processos rodando o job.
 * RLS + FORCE pela empresa (função do alicerce, que também concede ao nayara_runtime sob guarda de existência do role).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.flag_alert_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        alert_key text NOT NULL,
        alert_type varchar(24) NOT NULL,
        entry_id uuid NULL,
        recipients integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_flag_alert_log_key_uq UNIQUE (company_id, alert_key),
        CONSTRAINT gov_flag_alert_log_type_chk CHECK (alert_type IN ('FLAG_EXPIRED', 'KILL_SWITCH_STALE', 'KILL_SWITCH_FAILED'))
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.flag_alert_log'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.flag_alert_log');
  },
};
