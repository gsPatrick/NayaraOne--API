'use strict';

/**
 * Marco 9, M9-D217 — circuit breaker: chamadas de teste em andamento no HALF_OPEN.
 *
 * `half_open_inflight` conta as chamadas de teste liberadas e ainda sem resultado (limite: policy.circuit.half_open_max_calls) e
 * `half_open_inflight_since` o instante em que a primeira delas saiu: se o processo que as fez cair antes de devolver o resultado, a
 * vaga não fica presa para sempre (passado o cooldown ela é devolvida). Só vale na linha ATUAL (window_minutes = 0); a tabela já tem
 * RLS FORCE e os GRANTs da M9-D206.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."provider_health" ADD COLUMN IF NOT EXISTS half_open_inflight integer NOT NULL DEFAULT 0;');
    await q('ALTER TABLE "integration"."provider_health" ADD COLUMN IF NOT EXISTS half_open_inflight_since timestamptz;');
    await q(`DO $c$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_health_half_open_inflight_chk') THEN
        ALTER TABLE "integration"."provider_health" ADD CONSTRAINT provider_health_half_open_inflight_chk CHECK (half_open_inflight >= 0);
      END IF;
    END $c$;`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."provider_health" DROP CONSTRAINT IF EXISTS provider_health_half_open_inflight_chk;');
    await q('ALTER TABLE "integration"."provider_health" DROP COLUMN IF EXISTS half_open_inflight_since;');
    await q('ALTER TABLE "integration"."provider_health" DROP COLUMN IF EXISTS half_open_inflight;');
  },
};
