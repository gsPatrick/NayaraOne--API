'use strict';

/**
 * Marco 9, M9-D211 — resolução pública do canal de webhook.
 *  - integration.resolve_webhook_connection(provider, channel): função SECURITY DEFINER, somente leitura, com search_path fixo, que devolve
 *    connection_id, group_id, company_id, status e environment da connection do canal. É o único jeito de a rota pública (sem login e sem
 *    empresa na sessão) descobrir a empresa dona do canal; connection DISABLED não é devolvida. A função liga, só dentro dela, a chave de sessão
 *    app.webhook_channel_lookup, que a política webhook_channel_lookup (SELECT) exige igual ao canal da linha.
 *  - Todas as connections que ainda não tinham canal ganham um token opaco de 32 caracteres [0-9a-f] (de gen_random_uuid()); as novas nascem com o
 *    token gerado pelo serviço de connections. A UNIQUE (provider_code, webhook_channel) vem da migration 650.
 */
const guardado = (sql) => `DO $g$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN ${sql} END IF; END $g$;`;

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q('DROP POLICY IF EXISTS webhook_channel_lookup ON "integration"."connections";');
    await q(`CREATE POLICY webhook_channel_lookup ON "integration"."connections" FOR SELECT
      USING (webhook_channel IS NOT NULL AND webhook_channel = NULLIF(current_setting('app.webhook_channel_lookup', true), ''));`);

    await q(`
      CREATE OR REPLACE FUNCTION "integration".resolve_webhook_connection(p_provider varchar, p_channel varchar)
      RETURNS TABLE (connection_id uuid, group_id uuid, company_id uuid, status varchar, environment varchar)
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, "integration" AS $f$
      BEGIN
        IF p_provider IS NULL OR p_channel IS NULL OR length(p_channel) < 1 OR length(p_channel) > 48 THEN
          RETURN;
        END IF;
        PERFORM set_config('app.webhook_channel_lookup', p_channel, true);
        RETURN QUERY
          SELECT c.id, c.group_id, c.company_id, c.status::varchar, c.environment::varchar
            FROM "integration"."connections" c
           WHERE c.provider_code = lower(p_provider) AND c.webhook_channel = p_channel AND c.status <> 'DISABLED'
           LIMIT 1;
        PERFORM set_config('app.webhook_channel_lookup', '', true);
      END $f$;
    `);
    await q('REVOKE ALL ON FUNCTION "integration".resolve_webhook_connection(varchar, varchar) FROM PUBLIC;');
    await q(guardado('GRANT EXECUTE ON FUNCTION "integration".resolve_webhook_connection(varchar, varchar) TO nayara_runtime;'));

    // Backfill do canal (a tabela tem FORCE RLS: o dono não enxerga linhas sem empresa; liberamos só durante a cópia, como na migration 650).
    await q('ALTER TABLE "integration"."connections" NO FORCE ROW LEVEL SECURITY;');
    try {
      await q(`UPDATE "integration"."connections"
                  SET webhook_channel = substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 32)
                WHERE webhook_channel IS NULL;`);
    } finally {
      await q('ALTER TABLE "integration"."connections" FORCE ROW LEVEL SECURITY;');
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP FUNCTION IF EXISTS "integration".resolve_webhook_connection(varchar, varchar);');
    await q('DROP POLICY IF EXISTS webhook_channel_lookup ON "integration"."connections";');
  },
};
