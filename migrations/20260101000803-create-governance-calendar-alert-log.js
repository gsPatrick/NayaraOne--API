'use strict';

/**
 * M9-D802 — registro dos alertas do Calendário (vencido e conflito de agenda). A chave de deduplicação
 * (`calendar.overdue:<item>:<AAAA-MM-DD>`, `calendar.conflict:<menor>:<maior>:<AAAA-MM-DD>`) é UNIQUE por empresa: o mesmo alerta nunca é
 * criado duas vezes, mesmo com dois processos rodando o job. RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.calendar_alert_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        alert_key text NOT NULL,
        alert_type varchar(24) NOT NULL,
        item_id uuid NULL,
        recipients integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_cal_alert_log_key_uq UNIQUE (company_id, alert_key),
        CONSTRAINT gov_cal_alert_log_type_chk CHECK (alert_type IN ('OVERDUE', 'CALENDAR_CONFLICT'))
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.calendar_alert_log'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.calendar_alert_log');
  },
};
