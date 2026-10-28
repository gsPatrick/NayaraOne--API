'use strict';

/**
 * Marco 9, M9-D204 — integration.outbox_events passa a poder apontar um destino externo.
 * Aditiva e reversível: duas colunas nulas (connection_id, target_domain) e o índice (status, next_retry_at).
 * Evento sem destino (as duas colunas nulas) segue o caminho interno de sempre. RLS/FORCE já existem
 * na tabela e não são tocados. O down recusa quando há dado nas colunas novas (perderia informação).
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql, opts) => queryInterface.sequelize.query(sql, opts);
    await q('ALTER TABLE "integration"."outbox_events" ADD COLUMN IF NOT EXISTS connection_id uuid NULL;');
    await q('ALTER TABLE "integration"."outbox_events" ADD COLUMN IF NOT EXISTS target_domain varchar(24) NULL;');
    await q(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outbox_events_connection_fk') THEN
        ALTER TABLE "integration"."outbox_events" ADD CONSTRAINT outbox_events_connection_fk
          FOREIGN KEY (connection_id) REFERENCES "integration"."connections"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
      END IF;
    END $$;`);
    await q('CREATE INDEX IF NOT EXISTS outbox_events_status_next_retry_idx ON "integration"."outbox_events" (status, next_retry_at);');
  },

  down: async (queryInterface) => {
    const q = (sql, opts) => queryInterface.sequelize.query(sql, opts);
    const [[{ n }]] = await q('SELECT count(*)::int AS n FROM "integration"."outbox_events" WHERE target_domain IS NOT NULL OR connection_id IS NOT NULL;');
    if (n > 0) {
      throw new Error(`Reversão recusada: ${n} evento(s) do outbox usam target_domain/connection_id; esvazie-os antes (perderia informação).`);
    }
    await q('DROP INDEX IF EXISTS "integration"."outbox_events_status_next_retry_idx";');
    await q('ALTER TABLE "integration"."outbox_events" DROP CONSTRAINT IF EXISTS outbox_events_connection_fk;');
    await q('ALTER TABLE "integration"."outbox_events" DROP COLUMN IF EXISTS target_domain;');
    await q('ALTER TABLE "integration"."outbox_events" DROP COLUMN IF EXISTS connection_id;');
  },
};
