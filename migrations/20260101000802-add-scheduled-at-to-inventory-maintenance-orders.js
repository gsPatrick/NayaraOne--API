'use strict';

/**
 * M9-D802 — a ordem de manutenção (inventory.maintenance_orders) ganha a data agendada, de onde o Calendário unificado projeta a
 * fonte MAINTENANCE (DI-D802-1). Ordens já abertas recebem a própria data de abertura como agendamento. Idempotente e reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('ALTER TABLE inventory.maintenance_orders ADD COLUMN IF NOT EXISTS scheduled_at timestamptz NULL', { transaction });
      await sequelize.query('UPDATE inventory.maintenance_orders SET scheduled_at = opened_at WHERE scheduled_at IS NULL', { transaction });
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE inventory.maintenance_orders DROP COLUMN IF EXISTS scheduled_at');
  },
};
