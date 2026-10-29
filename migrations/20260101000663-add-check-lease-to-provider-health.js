'use strict';

/**
 * Marco 9, M9-D223 — health check ativo: um teste por connection por vez (lease).
 *
 * `check_lease_owner` e `check_lease_until` marcam quem está testando a connection e até quando. O lease é tomado por UPDATE
 * condicional (só se não houver lease vigente), então duas instâncias nunca chamam o fornecedor ao mesmo tempo; se o processo cair,
 * o lease vence sozinho. Só vale na linha ATUAL (window_minutes = 0) de provider_health, que já tem RLS FORCE e os GRANTs da M9-D206.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."provider_health" ADD COLUMN IF NOT EXISTS check_lease_owner varchar(64);');
    await q('ALTER TABLE "integration"."provider_health" ADD COLUMN IF NOT EXISTS check_lease_until timestamptz;');
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."provider_health" DROP COLUMN IF EXISTS check_lease_until;');
    await q('ALTER TABLE "integration"."provider_health" DROP COLUMN IF EXISTS check_lease_owner;');
  },
};
