'use strict';

/**
 * Marco 9, M9-D232 — vínculo do imóvel com cada portal imobiliário e os três portais sandbox do laboratório.
 *  - real_estate.portal_listings: um anúncio por (imóvel, portal) ativo (UNIQUE parcial com superseded_at nulo), com o id do anúncio no portal (external_listing_id),
 *    o estado (PENDING_SYNC, PUBLISHING, PUBLISHED, REJECTED, UNPUBLISHING, UNPUBLISHED, ERROR), a versão do mapping, o hash do último conteúdo enviado, os campos omitidos por
 *    capacidade ausente do portal, o motivo de rejeição, a última sincronização e o último erro. RLS ENABLE + FORCE por empresa.
 *  - catálogo: portal-zap-sandbox, portal-vivareal-sandbox e portal-olx-sandbox (seed idempotente, nunca sobrescreve status, política nem criticidade do administrador).
 */
const ESTADOS = ['PENDING_SYNC', 'PUBLISHING', 'PUBLISHED', 'REJECTED', 'UNPUBLISHING', 'UNPUBLISHED', 'ERROR'];
const CODIGOS = ['portal-zap-sandbox', 'portal-vivareal-sandbox', 'portal-olx-sandbox'];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE TABLE IF NOT EXISTS "real_estate"."portal_listings" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        property_id uuid NOT NULL REFERENCES "real_estate"."properties"(id) ON DELETE CASCADE ON UPDATE CASCADE,
        connection_id uuid NOT NULL REFERENCES "integration"."connections"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        external_listing_id varchar(160),
        status varchar(16) NOT NULL DEFAULT 'PENDING_SYNC' CHECK (status IN (${ESTADOS.map((e) => `'${e}'`).join(', ')})),
        mapping_version varchar(16) NOT NULL,
        payload_hash char(64),
        fields_dropped jsonb NOT NULL DEFAULT '[]'::jsonb,
        rejection_reason varchar(200),
        last_synced_at timestamptz,
        last_error text,
        superseded_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q('CREATE UNIQUE INDEX IF NOT EXISTS portal_listings_active_uidx ON "real_estate"."portal_listings" (property_id, connection_id) WHERE superseded_at IS NULL;');
    await q('CREATE INDEX IF NOT EXISTS portal_listings_status_idx ON "real_estate"."portal_listings" (company_id, status);');
    await q('CREATE INDEX IF NOT EXISTS portal_listings_connection_idx ON "real_estate"."portal_listings" (connection_id, id) WHERE superseded_at IS NULL;');
    await q('ALTER TABLE "real_estate"."portal_listings" ENABLE ROW LEVEL SECURITY;');
    await q(`DO $p$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'tenant_isolation' AND polrelid = '"real_estate"."portal_listings"'::regclass) THEN
        CREATE POLICY tenant_isolation ON "real_estate"."portal_listings"
          USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
          WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
      END IF;
    END $p$;`);
    await q('ALTER TABLE "real_estate"."portal_listings" FORCE ROW LEVEL SECURITY;');
    await q(`DO $g$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON "real_estate"."portal_listings" TO nayara_runtime;
      END IF;
    END $g$;`);
    const { seedCatalog } = require('../src/features/integrations/providers/catalog.seed');
    const { SEED_PROVIDERS } = require('../src/features/integrations/providers/catalog.providers');
    await queryInterface.sequelize.transaction((transaction) => seedCatalog(queryInterface.sequelize, transaction, SEED_PROVIDERS.filter((p) => CODIGOS.includes(p.code))));
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TABLE IF EXISTS "real_estate"."portal_listings";');
    // providers_no_delete (migration 650) barra DELETE; o seed só remove o que ele mesmo inseriu, então o gatilho é suspenso só aqui
    await queryInterface.sequelize.query('ALTER TABLE "integration"."providers" DISABLE TRIGGER providers_no_delete');
    await q(`DELETE FROM "integration"."providers" WHERE code IN (${CODIGOS.map((c) => `'${c}'`).join(', ')}) AND NOT EXISTS (SELECT 1 FROM "integration"."connections" c WHERE c.provider_code IN (${CODIGOS.map((c) => `'${c}'`).join(', ')}));`);
    await queryInterface.sequelize.query('ALTER TABLE "integration"."providers" ENABLE TRIGGER providers_no_delete');
  },
};
