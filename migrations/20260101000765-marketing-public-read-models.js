'use strict';

/**
 * M9-D403 — Dados publicáveis: visões públicas do Marketing e a política de endereço do imóvel.
 *
 * Em real_estate.properties: public_address_policy (COMPLETO | RUA_SEM_NUMERO | SO_BAIRRO | OCULTO, padrão SO_BAIRRO, o mais
 * restritivo depois de OCULTO), public_id (identificador opaco e imutável que sai para o mundo no lugar do id interno) e
 * published_at (instante em que o imóvel passou a PUBLISHED; mantido por gatilho, vale para qualquer caminho de publicação).
 * Em construction.project_stages: public_visible (a etapa pode ser citada em conteúdo público) e public_since (gatilho).
 *
 * Três visões, todas com security_invoker (herdam a RLS das tabelas de origem, nunca rodam com os privilégios do dono):
 *   marketing.v_public_property      campos publicáveis do imóvel, JÁ com a política de endereço aplicada no SQL;
 *   marketing.v_public_construction  empreendimento + etapa publicável + fotos autorizadas;
 *   marketing.v_relationship_facts   primeiro nome, marco, dia e mês (POST_SALE e aniversário): só canal privado, nunca público.
 * O serviço de conteúdo lê SOMENTE estas visões (nunca as tabelas de origem).
 *
 * Idempotente, numa transação. O GRANT ao runtime só é emitido se o role existir.
 */

const NUM = (col) => `CASE WHEN jsonb_typeof(p.attributes_json -> '${col}') = 'number' THEN (p.attributes_json ->> '${col}')::numeric END`;
const FLAG = (col) => `COALESCE((p.attributes_json ->> '${col}') = 'true', false)`;

const FEATURES_SQL = `ARRAY_REMOVE(ARRAY[
          CASE WHEN ${FLAG('pool')} THEN 'piscina' END,
          CASE WHEN ${FLAG('barbecue')} THEN 'churrasqueira' END,
          CASE WHEN ${FLAG('balcony')} THEN 'varanda' END,
          CASE WHEN ${FLAG('elevator')} THEN 'elevador' END,
          CASE WHEN ${FLAG('gym')} THEN 'academia' END,
          CASE WHEN ${FLAG('playground')} THEN 'playground' END,
          CASE WHEN ${FLAG('partyRoom')} THEN 'salão de festas' END,
          CASE WHEN ${FLAG('concierge24h')} THEN 'portaria 24h' END,
          CASE WHEN ${FLAG('airConditioning')} THEN 'ar-condicionado' END,
          CASE WHEN ${FLAG('furnished')} THEN 'mobiliado' END,
          CASE WHEN ${FLAG('petsFriendly')} THEN 'aceita pets' END,
          CASE WHEN COALESCE(${NUM('coveredParkingSpots')}, 0) > 0 THEN 'vaga coberta' END
        ], NULL)`;

const PHOTOS_SQL = (propertyIdExpr) => `ARRAY(
          SELECT m.id::text FROM real_estate.property_media m
           WHERE m.property_id = ${propertyIdExpr} AND m.media_type = 'PHOTO' AND m.quality_status = 'APPROVED'
           ORDER BY m.position, m.created_at, m.id)`;

const VIEW_PROPERTY = `
CREATE OR REPLACE VIEW marketing.v_public_property WITH (security_invoker = true) AS
SELECT
  p.id AS property_id,
  p.group_id,
  p.company_id,
  p.lock_version AS source_version,
  p.public_id,
  p.property_type AS tipo,
  CASE WHEN sale.id IS NOT NULL AND rent.id IS NOT NULL THEN 'VENDA_E_LOCACAO'
       WHEN sale.id IS NOT NULL THEN 'VENDA'
       WHEN rent.id IS NOT NULL THEN 'LOCACAO' END AS finalidade,
  p.public_address_policy AS politica_endereco,
  CASE WHEN p.public_address_policy = 'OCULTO' THEN NULL ELSE a.neighborhood END AS bairro,
  COALESCE(a.city, p.city) AS cidade,
  COALESCE(a.state, p.state) AS uf,
  CASE WHEN p.public_address_policy IN ('COMPLETO', 'RUA_SEM_NUMERO') THEN a.street END AS logradouro,
  CASE WHEN p.public_address_policy = 'COMPLETO' THEN a.number END AS numero_endereco,
  p.bedrooms AS quartos,
  round(${NUM('suites')})::int AS suites,
  round(${NUM('bathrooms')})::int AS banheiros,
  p.parking_spots AS vagas,
  ${NUM('usableAreaM2')} AS area_util_m2,
  p.area_total_m2 AS area_total_m2,
  sale.asking_price AS preco_venda,
  rent.asking_price AS preco_locacao,
  prev.old_price AS preco_anterior,
  condo.value_amount AS condominio,
  iptu.value_amount AS iptu,
  ${FEATURES_SQL} AS features,
  ${PHOTOS_SQL('p.id')} AS fotos_autorizadas,
  p.published_at AS publicado_em
FROM real_estate.properties p
LEFT JOIN real_estate.property_addresses a ON a.id = p.address_id
LEFT JOIN LATERAL (
  SELECT o.id, o.asking_price FROM real_estate.property_offers o
   WHERE o.property_id = p.id AND o.offer_type = 'SALE' AND o.status = 'ACTIVE' AND o.deleted_at IS NULL
   ORDER BY o.created_at DESC, o.id LIMIT 1) sale ON true
LEFT JOIN LATERAL (
  SELECT o.id, o.asking_price FROM real_estate.property_offers o
   WHERE o.property_id = p.id AND o.offer_type = 'RENT' AND o.status = 'ACTIVE' AND o.deleted_at IS NULL
   ORDER BY o.created_at DESC, o.id LIMIT 1) rent ON true
LEFT JOIN LATERAL (
  SELECT h.old_price FROM real_estate.property_price_history h
   WHERE h.offer_id = COALESCE(sale.id, rent.id) AND h.old_price IS NOT NULL
   ORDER BY h.changed_at DESC, h.id LIMIT 1) prev ON true
LEFT JOIN LATERAL (
  SELECT d.value_amount FROM real_estate.property_documents d
   WHERE d.property_id = p.id AND d.document_type = 'CONDO_FEE'
   ORDER BY d.created_at DESC, d.id LIMIT 1) condo ON true
LEFT JOIN LATERAL (
  SELECT d.value_amount FROM real_estate.property_documents d
   WHERE d.property_id = p.id AND d.document_type = 'IPTU'
   ORDER BY d.created_at DESC, d.id LIMIT 1) iptu ON true
WHERE p.deleted_at IS NULL AND p.publication_status <> 'DRAFT'`;

const VIEW_CONSTRUCTION = `
CREATE OR REPLACE VIEW marketing.v_public_construction WITH (security_invoker = true) AS
SELECT
  pr.id AS project_id,
  pr.group_id,
  pr.company_id,
  pr.updated_at AS source_updated_at,
  pr.name AS nome_empreendimento,
  st.name AS etapa_publica,
  ${PHOTOS_SQL('pr.property_id')} AS fotos_autorizadas,
  (SELECT min(s2.public_since) FROM construction.project_stages s2
    WHERE s2.project_id = pr.id AND s2.public_visible AND s2.deleted_at IS NULL) AS publicado_em
FROM construction.projects pr
JOIN LATERAL (
  SELECT s.name FROM construction.project_stages s
   WHERE s.project_id = pr.id AND s.public_visible AND s.deleted_at IS NULL AND s.status IN ('IN_PROGRESS', 'DONE')
   ORDER BY s.sequence DESC, s.id LIMIT 1) st ON true
WHERE pr.deleted_at IS NULL`;

const VIEW_RELATIONSHIP = `
CREATE OR REPLACE VIEW marketing.v_relationship_facts WITH (security_invoker = true) AS
SELECT pe.group_id, pe.company_id, pe.id AS person_id,
       split_part(btrim(COALESCE(NULLIF(btrim(pe.preferred_name), ''), pe.legal_name)), ' ', 1) AS primeiro_nome,
       'BIRTHDAY'::text AS marco,
       extract(day FROM pe.birth_or_foundation_date)::int AS dia,
       extract(month FROM pe.birth_or_foundation_date)::int AS mes,
       NULL::date AS data_marco
  FROM people.persons pe
 WHERE pe.deleted_at IS NULL AND pe.status = 'ACTIVE' AND pe.person_type = 'PF' AND pe.birth_or_foundation_date IS NOT NULL
UNION ALL
SELECT pe.group_id, pe.company_id, pe.id AS person_id,
       split_part(btrim(COALESCE(NULLIF(btrim(pe.preferred_name), ''), pe.legal_name)), ' ', 1) AS primeiro_nome,
       'POST_SALE_KEYS'::text AS marco,
       extract(day FROM kd.delivered_at)::int AS dia,
       extract(month FROM kd.delivered_at)::int AS mes,
       kd.delivered_at::date AS data_marco
  FROM legal.key_deliveries kd
  JOIN people.persons pe ON pe.id = kd.delivered_to_person_id
 WHERE kd.deleted_at IS NULL AND kd.delivered_at IS NOT NULL AND kd.cancelled_at IS NULL
   AND pe.deleted_at IS NULL AND pe.status = 'ACTIVE' AND pe.person_type = 'PF'`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });

      await q('CREATE SCHEMA IF NOT EXISTS marketing');

      await q(`ALTER TABLE real_estate.properties
        ADD COLUMN IF NOT EXISTS public_address_policy varchar(16) NOT NULL DEFAULT 'SO_BAIRRO',
        ADD COLUMN IF NOT EXISTS public_id uuid NOT NULL DEFAULT gen_random_uuid(),
        ADD COLUMN IF NOT EXISTS published_at timestamptz NULL`);
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'properties_public_address_policy_chk') THEN
          ALTER TABLE real_estate.properties ADD CONSTRAINT properties_public_address_policy_chk
            CHECK (public_address_policy IN ('COMPLETO', 'RUA_SEM_NUMERO', 'SO_BAIRRO', 'OCULTO'));
        END IF;
      END $$`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS properties_public_id_uq ON real_estate.properties (public_id)');

      await q(`CREATE OR REPLACE FUNCTION marketing.fn_property_published_at() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.publication_status = 'PUBLISHED' AND (TG_OP = 'INSERT' OR OLD.publication_status IS DISTINCT FROM 'PUBLISHED') THEN
            NEW.published_at := now();
          END IF;
          RETURN NEW;
        END $$`);
      await q('DROP TRIGGER IF EXISTS trg_property_published_at ON real_estate.properties');
      await q(`CREATE TRIGGER trg_property_published_at BEFORE INSERT OR UPDATE OF publication_status ON real_estate.properties
        FOR EACH ROW EXECUTE FUNCTION marketing.fn_property_published_at()`);
      // Imóveis já publicados antes desta migration: a data mais próxima que existe é a da última alteração.
      await q(`DO $$ DECLARE f boolean; BEGIN
        SELECT relforcerowsecurity INTO f FROM pg_class WHERE oid = 'real_estate.properties'::regclass;
        IF f THEN ALTER TABLE real_estate.properties NO FORCE ROW LEVEL SECURITY; END IF;
        UPDATE real_estate.properties SET published_at = updated_at WHERE publication_status = 'PUBLISHED' AND published_at IS NULL;
        IF f THEN ALTER TABLE real_estate.properties FORCE ROW LEVEL SECURITY; END IF;
      END $$`);

      await q(`ALTER TABLE construction.project_stages
        ADD COLUMN IF NOT EXISTS public_visible boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS public_since timestamptz NULL`);
      await q(`CREATE OR REPLACE FUNCTION marketing.fn_stage_public_since() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.public_visible AND (TG_OP = 'INSERT' OR NOT OLD.public_visible) THEN
            NEW.public_since := now();
          ELSIF NOT NEW.public_visible THEN
            NEW.public_since := NULL;
          END IF;
          RETURN NEW;
        END $$`);
      await q('DROP TRIGGER IF EXISTS trg_stage_public_since ON construction.project_stages');
      await q(`CREATE TRIGGER trg_stage_public_since BEFORE INSERT OR UPDATE OF public_visible ON construction.project_stages
        FOR EACH ROW EXECUTE FUNCTION marketing.fn_stage_public_since()`);

      await q(VIEW_PROPERTY);
      await q(VIEW_CONSTRUCTION);
      await q(VIEW_RELATIONSHIP);

      await q(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA marketing TO nayara_runtime;
          GRANT SELECT ON marketing.v_public_property, marketing.v_public_construction, marketing.v_relationship_facts TO nayara_runtime;
        END IF;
      END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP VIEW IF EXISTS marketing.v_relationship_facts');
      await q('DROP VIEW IF EXISTS marketing.v_public_construction');
      await q('DROP VIEW IF EXISTS marketing.v_public_property');
      await q('DROP TRIGGER IF EXISTS trg_stage_public_since ON construction.project_stages');
      await q('DROP FUNCTION IF EXISTS marketing.fn_stage_public_since()');
      await q('ALTER TABLE construction.project_stages DROP COLUMN IF EXISTS public_since, DROP COLUMN IF EXISTS public_visible');
      await q('DROP TRIGGER IF EXISTS trg_property_published_at ON real_estate.properties');
      await q('DROP FUNCTION IF EXISTS marketing.fn_property_published_at()');
      await q('DROP INDEX IF EXISTS real_estate.properties_public_id_uq');
      await q('ALTER TABLE real_estate.properties DROP CONSTRAINT IF EXISTS properties_public_address_policy_chk');
      await q('ALTER TABLE real_estate.properties DROP COLUMN IF EXISTS published_at, DROP COLUMN IF EXISTS public_id, DROP COLUMN IF EXISTS public_address_policy');
    });
  },
};
