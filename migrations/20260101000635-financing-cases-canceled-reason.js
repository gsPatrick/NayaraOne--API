'use strict';

/** Marco 8 — motivo e data do cancelamento ficam no próprio caso (a tela mostra o porquê). */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE "correspondent"."financing_cases"
      ADD COLUMN IF NOT EXISTS canceled_reason TEXT,
      ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ`);
    await queryInterface.sequelize.query(`UPDATE "correspondent"."financing_cases" SET canceled_at = updated_at, canceled_reason = 'Cancelado antes do registro do motivo' WHERE status = 'CANCELED' AND canceled_at IS NULL`);
    await queryInterface.sequelize.query(`ALTER TABLE "correspondent"."financing_cases"
      ADD CONSTRAINT financing_cases_canceled_reason_check CHECK (status <> 'CANCELED' OR (canceled_reason IS NOT NULL AND canceled_at IS NOT NULL))`);
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE "correspondent"."financing_cases" DROP CONSTRAINT IF EXISTS financing_cases_canceled_reason_check`);
    await queryInterface.sequelize.query(`ALTER TABLE "correspondent"."financing_cases" DROP COLUMN IF EXISTS canceled_at, DROP COLUMN IF EXISTS canceled_reason`);
  },
};
