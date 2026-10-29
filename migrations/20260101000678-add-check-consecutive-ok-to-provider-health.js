'use strict';

/**
 * Marco 9, M9-D226 — integration.provider_health ganha a contagem de testes de saúde SEGUIDOS que deram certo (`check_consecutive_ok`).
 * A contingência só encerra depois de `integration.contingency.recovery_checks` (padrão 3) testes seguidos OK; um teste que falha zera a contagem.
 * Não há tabela nova (o estado da contingência é derivado e auditado em integration_errors); a coluna nova herda a RLS e os grants da tabela.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."provider_health" ADD COLUMN IF NOT EXISTS check_consecutive_ok integer NOT NULL DEFAULT 0;');
    await q(`DO $c$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_health_check_ok_chk') THEN
        ALTER TABLE "integration"."provider_health" ADD CONSTRAINT provider_health_check_ok_chk CHECK (check_consecutive_ok >= 0);
      END IF;
    END $c$;`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."provider_health" DROP CONSTRAINT IF EXISTS provider_health_check_ok_chk;');
    await q('ALTER TABLE "integration"."provider_health" DROP COLUMN IF EXISTS check_consecutive_ok;');
  },
};
