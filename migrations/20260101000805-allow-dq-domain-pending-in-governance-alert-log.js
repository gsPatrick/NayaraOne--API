'use strict';

/**
 * M9-D804 — o registro de alertas de governança (governance.calendar_alert_log, M9-D802) passa a aceitar também o aviso de domínio
 * de dados sem responsável (`DQ_DOMAIN_PENDING`, chave `dq.domain_pending:<domínio>:<AAAA-MM-DD>`), um por domínio e por dia.
 * Idempotente e reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('ALTER TABLE governance.calendar_alert_log DROP CONSTRAINT IF EXISTS gov_cal_alert_log_type_chk', { transaction });
      await sequelize.query(
        "ALTER TABLE governance.calendar_alert_log ADD CONSTRAINT gov_cal_alert_log_type_chk CHECK (alert_type IN ('OVERDUE', 'CALENDAR_CONFLICT', 'DQ_DOMAIN_PENDING'))",
        { transaction }
      );
    });
  },
  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query("DELETE FROM governance.calendar_alert_log WHERE alert_type = 'DQ_DOMAIN_PENDING'", { transaction });
      await sequelize.query('ALTER TABLE governance.calendar_alert_log DROP CONSTRAINT IF EXISTS gov_cal_alert_log_type_chk', { transaction });
      await sequelize.query("ALTER TABLE governance.calendar_alert_log ADD CONSTRAINT gov_cal_alert_log_type_chk CHECK (alert_type IN ('OVERDUE', 'CALENDAR_CONFLICT'))", { transaction });
    });
  },
};
