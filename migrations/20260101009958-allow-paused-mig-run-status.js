'use strict';

/**
 * M9-D908 §3.1 — governance.mig_runs ganha o estado PAUSED: o aplicador para antes do lote quando os relógios divergem além do limite e retoma sozinho, do último checkpoint,
 * quando a medição volta ao limite (PAUSED -> QUEUED). Reversível (execuções PAUSED voltam a QUEUED ao desfazer).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE governance.mig_runs DROP CONSTRAINT IF EXISTS mig_runs_status_chk');
      await q("ALTER TABLE governance.mig_runs ADD CONSTRAINT mig_runs_status_chk CHECK (status IN ('QUEUED', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED'))");
    });
  },
  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q("UPDATE governance.mig_runs SET status = 'QUEUED' WHERE status = 'PAUSED'");
      await q('ALTER TABLE governance.mig_runs DROP CONSTRAINT IF EXISTS mig_runs_status_chk');
      await q("ALTER TABLE governance.mig_runs ADD CONSTRAINT mig_runs_status_chk CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'))");
    });
  },
};
