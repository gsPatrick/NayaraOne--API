'use strict';

/**
 * M9-D427 — Ciclo de vida da página pública do imóvel (site e SEO).
 *
 * 1. real_estate.properties.lifecycle_changed_at: instante em que o imóvel mudou de situação (disponibilidade ou publicação), mantido por
 *    gatilho do banco para valer em qualquer caminho de escrita. É daqui que saem "vendido há N dias" e "removido há N dias".
 * 2. public_id imutável: gatilho que recusa qualquer UPDATE do identificador público (o link de uma página nunca quebra por troca de id).
 * 3. marketing.v_public_page (security_invoker): o que a rota pública precisa para decidir 200, 301 ou 410: identificador público, tipo,
 *    bairro (já com a política de endereço), a finalidade da oferta (vigente ou a última que existiu), as duas situações e o instante da mudança.
 *    Só aparece imóvel que já foi publicado alguma vez (published_at preenchido): rascunho nunca tem página.
 * 4. marketing.resolve_public_page(public_id): SECURITY DEFINER para a rota pública achar a empresa do imóvel ANTES de abrir a sessão do
 *    tenant (mesmo padrão de marketing.resolve_tracking_link); devolve só group_id e company_id e nunca lista imóveis.
 *
 * Sem tabela nova. O EXECUTE da função só é concedido a papéis que existem (guarda de existência).
 */
const VIEW_PAGE = `
CREATE OR REPLACE VIEW marketing.v_public_page WITH (security_invoker = true) AS
SELECT
  p.id AS property_id,
  p.group_id,
  p.company_id,
  p.public_id,
  p.property_type AS tipo,
  CASE WHEN p.public_address_policy = 'OCULTO' THEN NULL ELSE a.neighborhood END AS bairro,
  COALESCE(a.city, p.city) AS cidade,
  p.bedrooms AS quartos,
  CASE WHEN EXISTS (SELECT 1 FROM real_estate.property_offers o WHERE o.property_id = p.id AND o.offer_type = 'SALE' AND o.deleted_at IS NULL) THEN 'VENDA'
       WHEN EXISTS (SELECT 1 FROM real_estate.property_offers o WHERE o.property_id = p.id AND o.offer_type = 'RENT' AND o.deleted_at IS NULL) THEN 'LOCACAO'
  END AS finalidade,
  p.publication_status,
  p.availability_status,
  p.published_at,
  p.lifecycle_changed_at,
  p.updated_at
FROM real_estate.properties p
LEFT JOIN real_estate.property_addresses a ON a.id = p.address_id
WHERE p.deleted_at IS NULL AND p.published_at IS NOT NULL`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('CREATE SCHEMA IF NOT EXISTS marketing');
      await q('ALTER TABLE real_estate.properties ADD COLUMN IF NOT EXISTS lifecycle_changed_at timestamptz NULL');
      await q(`CREATE OR REPLACE FUNCTION marketing.fn_property_lifecycle_changed_at() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'INSERT' THEN
            NEW.lifecycle_changed_at := COALESCE(NEW.lifecycle_changed_at, now());
          ELSIF NEW.availability_status IS DISTINCT FROM OLD.availability_status OR NEW.publication_status IS DISTINCT FROM OLD.publication_status THEN
            NEW.lifecycle_changed_at := now();
          END IF;
          RETURN NEW;
        END $$`);
      await q('DROP TRIGGER IF EXISTS trg_property_lifecycle_changed_at ON real_estate.properties');
      await q(`CREATE TRIGGER trg_property_lifecycle_changed_at BEFORE INSERT OR UPDATE OF availability_status, publication_status ON real_estate.properties
        FOR EACH ROW EXECUTE FUNCTION marketing.fn_property_lifecycle_changed_at()`);
      // Imóveis anteriores à migration: a data mais próxima que existe é a da última alteração.
      await q(`DO $$ DECLARE f boolean; BEGIN
        SELECT relforcerowsecurity INTO f FROM pg_class WHERE oid = 'real_estate.properties'::regclass;
        IF f THEN ALTER TABLE real_estate.properties NO FORCE ROW LEVEL SECURITY; END IF;
        UPDATE real_estate.properties SET lifecycle_changed_at = updated_at WHERE lifecycle_changed_at IS NULL;
        IF f THEN ALTER TABLE real_estate.properties FORCE ROW LEVEL SECURITY; END IF;
      END $$`);

      await q(`CREATE OR REPLACE FUNCTION marketing.fn_property_public_id_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.public_id IS DISTINCT FROM OLD.public_id THEN
            RAISE EXCEPTION 'MKT_PUBLIC_ID_IMMUTABLE: o identificador público do imóvel não pode ser alterado' USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END $$`);
      await q('DROP TRIGGER IF EXISTS trg_property_public_id_immutable ON real_estate.properties');
      await q(`CREATE TRIGGER trg_property_public_id_immutable BEFORE UPDATE OF public_id ON real_estate.properties
        FOR EACH ROW EXECUTE FUNCTION marketing.fn_property_public_id_immutable()`);

      await q(VIEW_PAGE);
      await q(`CREATE OR REPLACE FUNCTION marketing.resolve_public_page(p_public_id uuid)
        RETURNS TABLE (group_id uuid, company_id uuid)
        LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, real_estate AS $f$
          SELECT p.group_id, p.company_id FROM real_estate.properties p
           WHERE p.public_id = p_public_id AND p.deleted_at IS NULL AND p.published_at IS NOT NULL LIMIT 1
        $f$`);
      await q('REVOKE ALL ON FUNCTION marketing.resolve_public_page(uuid) FROM PUBLIC');
      await q(`DO $$ DECLARE r text; BEGIN
        FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('nayara_runtime', 'nayara_ci', 'nayara_ci_app') LOOP
          EXECUTE format('GRANT EXECUTE ON FUNCTION marketing.resolve_public_page(uuid) TO %I', r);
        END LOOP;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT ON marketing.v_public_page TO nayara_runtime;
        END IF;
      END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP FUNCTION IF EXISTS marketing.resolve_public_page(uuid)');
      await q('DROP VIEW IF EXISTS marketing.v_public_page');
      await q('DROP TRIGGER IF EXISTS trg_property_public_id_immutable ON real_estate.properties');
      await q('DROP FUNCTION IF EXISTS marketing.fn_property_public_id_immutable()');
      await q('DROP TRIGGER IF EXISTS trg_property_lifecycle_changed_at ON real_estate.properties');
      await q('DROP FUNCTION IF EXISTS marketing.fn_property_lifecycle_changed_at()');
      await q('ALTER TABLE real_estate.properties DROP COLUMN IF EXISTS lifecycle_changed_at');
    });
  },
};
