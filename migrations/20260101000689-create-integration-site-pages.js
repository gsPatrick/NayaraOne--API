'use strict';

/**
 * Marco 9, M9-D259 — integration.site_pages: a página publicada no site, ligada ao envio (dispatch) corrente.
 *  - status é o estado INTERNO (PENDING, PUBLISHED, UNPUBLISHING, UNPUBLISHED): só vira PUBLISHED/UNPUBLISHED por evento `integration.dispatch.confirmed`, nunca pela resposta HTTP.
 *  - site_sync_status é o que falta para o site refletir o ERP (SYNCED, PENDING_SYNC, FAILED): a falha do site nunca desfaz o status interno (INT-012).
 *  - dispatch_id/dispatch_operation/applied_rank/applied_status/dispatch_confirmed guardam a ordem dos status DENTRO do envio corrente (republicar cria envio novo e zera o ciclo).
 * RLS ENABLE + FORCE por empresa; o runtime lê, grava e atualiza (a página nunca é apagada).
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE TABLE IF NOT EXISTS "integration"."site_pages" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        connection_id uuid NOT NULL REFERENCES "integration"."connections"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        page_key varchar(160) NOT NULL,
        property_id uuid,
        slug varchar(160) NOT NULL,
        locale varchar(16) NOT NULL,
        content_hash varchar(64) NOT NULL,
        published_hash varchar(64),
        status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'UNPUBLISHING', 'UNPUBLISHED')),
        site_sync_status varchar(16) NOT NULL DEFAULT 'PENDING_SYNC' CHECK (site_sync_status IN ('SYNCED', 'PENDING_SYNC', 'FAILED')),
        publish_count integer NOT NULL DEFAULT 0,
        dispatch_id uuid REFERENCES "integration"."dispatches"(id) ON DELETE SET NULL ON UPDATE CASCADE,
        dispatch_operation varchar(32),
        applied_rank smallint NOT NULL DEFAULT -1,
        applied_status varchar(16),
        dispatch_confirmed boolean NOT NULL DEFAULT false,
        status_checks integer NOT NULL DEFAULT 0,
        status_checked_at timestamptz,
        published_at timestamptz,
        unpublished_at timestamptz,
        last_error varchar(300),
        requested_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q('CREATE UNIQUE INDEX IF NOT EXISTS site_pages_key_uidx ON "integration"."site_pages" (company_id, connection_id, page_key);');
    await q('CREATE INDEX IF NOT EXISTS site_pages_sync_idx ON "integration"."site_pages" (company_id, site_sync_status) WHERE site_sync_status = \'PENDING_SYNC\';');
    await q('CREATE INDEX IF NOT EXISTS site_pages_property_idx ON "integration"."site_pages" (company_id, property_id) WHERE property_id IS NOT NULL;');
    await q('ALTER TABLE "integration"."site_pages" ENABLE ROW LEVEL SECURITY;');
    await q(`CREATE POLICY tenant_isolation ON "integration"."site_pages"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);
    await q('ALTER TABLE "integration"."site_pages" FORCE ROW LEVEL SECURITY;');
    await q(`DO $g$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        GRANT USAGE ON SCHEMA "integration" TO nayara_runtime;
        GRANT SELECT, INSERT, UPDATE ON "integration"."site_pages" TO nayara_runtime;
      END IF;
    END $g$;`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "integration"."site_pages";');
  },
};
