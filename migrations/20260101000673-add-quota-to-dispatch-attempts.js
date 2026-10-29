'use strict';

/**
 * Marco 9, M9-D218 — a cota que o fornecedor informou na resposta (X-RateLimit-Limit, -Remaining, -Reset ou campo do corpo) fica na
 * tentativa que a trouxe: é o que o worker consulta para reservar a cota escassa às operações essenciais e para pausar as demais com
 * a cota zerada, e o que a fonte de amostras copia para provider_health. Só números e a data de renovação.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "integration"."dispatch_attempts" ADD COLUMN IF NOT EXISTS quota_limit integer;');
    await q('ALTER TABLE "integration"."dispatch_attempts" ADD COLUMN IF NOT EXISTS quota_remaining integer;');
    await q('ALTER TABLE "integration"."dispatch_attempts" ADD COLUMN IF NOT EXISTS quota_resets_at timestamptz;');
    await q(`DO $c$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_attempts_quota_chk') THEN
        ALTER TABLE "integration"."dispatch_attempts" ADD CONSTRAINT dispatch_attempts_quota_chk
          CHECK ((quota_limit IS NULL OR quota_limit >= 0) AND (quota_remaining IS NULL OR quota_remaining >= 0));
      END IF;
    END $c$;`);
    await q('CREATE INDEX IF NOT EXISTS dispatch_attempts_quota_idx ON "integration"."dispatch_attempts" (connection_id, started_at DESC) WHERE quota_limit IS NOT NULL OR quota_remaining IS NOT NULL;');
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP INDEX IF EXISTS "integration"."dispatch_attempts_quota_idx";');
    await q('ALTER TABLE "integration"."dispatch_attempts" DROP CONSTRAINT IF EXISTS dispatch_attempts_quota_chk;');
    await q('ALTER TABLE "integration"."dispatch_attempts" DROP COLUMN IF EXISTS quota_resets_at;');
    await q('ALTER TABLE "integration"."dispatch_attempts" DROP COLUMN IF EXISTS quota_remaining;');
    await q('ALTER TABLE "integration"."dispatch_attempts" DROP COLUMN IF EXISTS quota_limit;');
  },
};
