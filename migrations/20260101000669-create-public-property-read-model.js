'use strict';

/**
 * Marco 9, M9-D231 — PublicPropertyReadModel: a visão pública, reduzida e sanitizada do imóvel de onde saem o site e os portais.
 *
 * real_estate.properties ganha `address_visibility` (PUBLIC | APPROXIMATE | RESTRICTED; padrão RESTRICTED, o mais restritivo) e
 * `description_public` (texto público próprio, separado da descrição interna). A tabela real_estate.public_property_read_model
 * só tem as colunas dos campos públicos do livro mais as de controle (chave, empresa, hash do conteúdo): o que não é público não
 * existe nela. RLS ENABLE + FORCE por empresa. GRANT ao runtime só se o role existir.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE "real_estate"."properties"
      ADD COLUMN IF NOT EXISTS address_visibility varchar(12) NOT NULL DEFAULT 'RESTRICTED',
      ADD COLUMN IF NOT EXISTS description_public text;`);
    await q(`DO $c$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'properties_address_visibility_chk') THEN
        ALTER TABLE "real_estate"."properties" ADD CONSTRAINT properties_address_visibility_chk CHECK (address_visibility IN ('PUBLIC', 'APPROXIMATE', 'RESTRICTED'));
      END IF;
    END $c$;`);

    await q(`
      CREATE TABLE "real_estate"."public_property_read_model" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        property_id uuid NOT NULL UNIQUE REFERENCES "real_estate"."properties"(id) ON DELETE CASCADE ON UPDATE CASCADE,
        public_code varchar(24) NOT NULL,
        title varchar(255) NOT NULL,
        description_public text,
        purpose varchar(10) NOT NULL CHECK (purpose IN ('VENDA', 'LOCAÇÃO')),
        type varchar(32) NOT NULL,
        price_public numeric(14,2) NOT NULL CHECK (price_public >= 0),
        condo_fee_public numeric(14,2),
        iptu_public numeric(14,2),
        area_total numeric(12,2),
        area_built numeric(12,2),
        bedrooms integer,
        bathrooms integer,
        parking_spots integer,
        neighborhood varchar(100),
        city varchar(128),
        state varchar(2),
        lat_lng_public jsonb,
        photos_public jsonb NOT NULL DEFAULT '[]'::jsonb,
        video_public_url text,
        features_public jsonb NOT NULL DEFAULT '[]'::jsonb,
        published_at timestamptz,
        read_model_version integer NOT NULL DEFAULT 1 CHECK (read_model_version >= 1),
        content_hash char(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT public_property_read_model_code_unique UNIQUE (company_id, public_code)
      );
    `);
    await q('CREATE INDEX public_property_read_model_company_idx ON "real_estate"."public_property_read_model" (company_id, updated_at);');
    await q('ALTER TABLE "real_estate"."public_property_read_model" ENABLE ROW LEVEL SECURITY;');
    await q(`CREATE POLICY tenant_isolation ON "real_estate"."public_property_read_model"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);
    await q('ALTER TABLE "real_estate"."public_property_read_model" FORCE ROW LEVEL SECURITY;');
    await q(`DO $g$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        GRANT USAGE ON SCHEMA "real_estate" TO nayara_runtime;
        GRANT SELECT, INSERT, UPDATE, DELETE ON "real_estate"."public_property_read_model" TO nayara_runtime;
      END IF;
    END $g$;`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TABLE IF EXISTS "real_estate"."public_property_read_model";');
    await q('ALTER TABLE "real_estate"."properties" DROP CONSTRAINT IF EXISTS properties_address_visibility_chk;');
    await q('ALTER TABLE "real_estate"."properties" DROP COLUMN IF EXISTS description_public, DROP COLUMN IF EXISTS address_visibility;');
  },
};
