'use strict';

/**
 * Marco 3 (verificação independente de 11/11/2026, linhas M3-06, M3-07 e CAD-06) — só acrescenta colunas, nenhum dado muda:
 *  - real_estate.property_documents.file_id e real_estate.property_media.file_id: o documento e a mídia do imóvel passam a
 *    apontar para o arquivo real (people.files), conferido pelo antivírus no vínculo (livro §6 "Media: Arquivo, ordem,
 *    classificação, qualidade"; §3 "property_documents: Matrícula, IPTU etc."). As linhas antigas ficam como estão (file_id nulo):
 *    continuam listadas, mas não contam para o gate de publicação (DI-M3IM-2).
 *  - real_estate.property_offers.conditions: as "condições" da oferta (livro §6 "Offer: Venda/locação, preço, condições, status,
 *    financiamento, permuta").
 *  - real_estate.property_offers.superseded_by_offer_id e superseded_at: a substituição controlada guarda qual oferta substituiu
 *    a anterior e quando (M3-07).
 * Desfazer: remove as colunas e índices (as linhas continuam; só a referência ao arquivo e as condições somem).
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await queryInterface.sequelize.transaction(async (transaction) => {
      const t = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await t(`ALTER TABLE real_estate.property_documents
                 ADD COLUMN IF NOT EXISTS file_id uuid NULL REFERENCES people.files(id) ON DELETE RESTRICT ON UPDATE CASCADE`);
      await t(`ALTER TABLE real_estate.property_media
                 ADD COLUMN IF NOT EXISTS file_id uuid NULL REFERENCES people.files(id) ON DELETE RESTRICT ON UPDATE CASCADE`);
      await t('CREATE INDEX IF NOT EXISTS property_documents_file_id_idx ON real_estate.property_documents (file_id) WHERE file_id IS NOT NULL');
      await t('CREATE INDEX IF NOT EXISTS property_media_file_id_idx ON real_estate.property_media (file_id) WHERE file_id IS NOT NULL');
      await t('ALTER TABLE real_estate.property_offers ADD COLUMN IF NOT EXISTS conditions text NULL');
      await t(`ALTER TABLE real_estate.property_offers
                 ADD COLUMN IF NOT EXISTS superseded_by_offer_id uuid NULL REFERENCES real_estate.property_offers(id) ON DELETE RESTRICT ON UPDATE CASCADE`);
      await t('ALTER TABLE real_estate.property_offers ADD COLUMN IF NOT EXISTS superseded_at timestamptz NULL');
      await t(`COMMENT ON COLUMN real_estate.property_offers.conditions IS 'Condições comerciais da oferta (livro do Marco 3 §6): entrada, prazo, reajuste, o que está incluso etc.'`);
    });
    // A oferta substituta precisa ser do mesmo imóvel e do mesmo tipo: conferido no serviço (FOR UPDATE) e aqui como rede.
    await q(`CREATE OR REPLACE FUNCTION real_estate.property_offers_superseded_by_check() RETURNS trigger LANGUAGE plpgsql AS $fn$
      DECLARE substituta record;
      BEGIN
        IF NEW.superseded_by_offer_id IS NULL THEN RETURN NEW; END IF;
        SELECT property_id, offer_type INTO substituta FROM real_estate.property_offers WHERE id = NEW.superseded_by_offer_id;
        IF substituta.property_id IS DISTINCT FROM NEW.property_id OR substituta.offer_type IS DISTINCT FROM NEW.offer_type OR NEW.superseded_by_offer_id = NEW.id THEN
          RAISE EXCEPTION 'PROPERTY_OFFER_SUPERSEDED_BY_INVALID: a oferta substituta precisa ser outra oferta do mesmo imóvel e do mesmo tipo' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $fn$`);
    await q('DROP TRIGGER IF EXISTS property_offers_superseded_by_check_trg ON real_estate.property_offers');
    await q(`CREATE TRIGGER property_offers_superseded_by_check_trg BEFORE INSERT OR UPDATE OF superseded_by_offer_id ON real_estate.property_offers
             FOR EACH ROW EXECUTE FUNCTION real_estate.property_offers_superseded_by_check()`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const t = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await t('DROP TRIGGER IF EXISTS property_offers_superseded_by_check_trg ON real_estate.property_offers');
      await t('DROP FUNCTION IF EXISTS real_estate.property_offers_superseded_by_check()');
      await t('ALTER TABLE real_estate.property_offers DROP COLUMN IF EXISTS superseded_at');
      await t('ALTER TABLE real_estate.property_offers DROP COLUMN IF EXISTS superseded_by_offer_id');
      await t('ALTER TABLE real_estate.property_offers DROP COLUMN IF EXISTS conditions');
      await t('DROP INDEX IF EXISTS real_estate.property_media_file_id_idx');
      await t('DROP INDEX IF EXISTS real_estate.property_documents_file_id_idx');
      await t('ALTER TABLE real_estate.property_media DROP COLUMN IF EXISTS file_id');
      await t('ALTER TABLE real_estate.property_documents DROP COLUMN IF EXISTS file_id');
    });
  },
};
