'use strict';

/**
 * M45 (19/10/2026): entrega de chaves passa a ter CANCELAMENTO com motivo (status CANCELLED).
 * Motivo: entregas criadas antes da regra F6 (recebedor precisa ser parte do contrato) ficavam
 * PENDING para sempre, sem fluxo para encerrá-las. Nada é apagado: a linha fica com status
 * CANCELLED, quem cancelou, quando e o motivo — e a auditoria de negócio vai para audit.audit_log.
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE legal.key_deliveries
               ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NULL,
               ADD COLUMN IF NOT EXISTS cancelled_by uuid NULL,
               ADD COLUMN IF NOT EXISTS cancel_reason text NULL`);
    await q(`COMMENT ON COLUMN legal.key_deliveries.status IS 'PENDING|RELEASED|CANCELLED'`);
    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await q('GRANT SELECT, INSERT, UPDATE ON legal.key_deliveries TO nayara_runtime;');
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE legal.key_deliveries
      DROP COLUMN IF EXISTS cancelled_at, DROP COLUMN IF EXISTS cancelled_by, DROP COLUMN IF EXISTS cancel_reason`);
  },
};
