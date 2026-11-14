'use strict';

const { validarSeLimpo } = require('../src/shared/db/validarSeLimpo');
const { applyLegalTenantRls } = require('./_helpers/legalTenantTable');

/**
 * Fechamento M5 — Vistorias com os códigos e a estrutura do livro (Caderno M5 §4 legal.inspection_media, §11,
 * Guia §9/§10):
 *  - legal.inspections.inspection_type passa a guardar ENTRY/EXIT/INTERMEDIATE/FINAL. Os códigos antigos
 *    (CHECK_IN/CHECK_OUT/PERIODIC) são migrados e, se algum gravador legado ainda os mandar, um gatilho BEFORE
 *    os traduz antes do CHECK (leitura e escrita do legado continuam funcionando, o banco só guarda o do livro).
 *  - legal.inspection_items: ambiente (room_code), código do item (item_code), descrição de todo item
 *    (description) e condição NEW|GOOD|REGULAR|DAMAGED (CHECK).
 *  - legal.inspection_signatures.snapshot_hash: SHA-256 do JSON canônico da vistoria no momento da assinatura.
 *  - legal.inspection_media (tabela do livro): inspection_id, item_id, file_id, sha256, captured_at, media_type.
 * Reversível (o down devolve os códigos antigos e remove o que foi criado).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE OR REPLACE FUNCTION legal.inspection_type_do_livro() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          NEW.inspection_type := CASE upper(NEW.inspection_type)
            WHEN 'CHECK_IN' THEN 'ENTRY' WHEN 'CHECK_OUT' THEN 'EXIT' WHEN 'PERIODIC' THEN 'INTERMEDIATE'
            ELSE upper(NEW.inspection_type) END;
          RETURN NEW;
        END $f$`);
      await q('DROP TRIGGER IF EXISTS inspections_type_do_livro ON legal.inspections');
      await q(`CREATE TRIGGER inspections_type_do_livro BEFORE INSERT OR UPDATE OF inspection_type ON legal.inspections
        FOR EACH ROW EXECUTE FUNCTION legal.inspection_type_do_livro()`);
      await q(`UPDATE legal.inspections SET inspection_type = inspection_type WHERE inspection_type IN ('CHECK_IN','CHECK_OUT','PERIODIC')`);
      await q(`DO $c$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspections_type_livro_chk') THEN
          ALTER TABLE legal.inspections ADD CONSTRAINT inspections_type_livro_chk CHECK (inspection_type IN ('ENTRY','EXIT','INTERMEDIATE','FINAL')) NOT VALID;
        END IF;
      END $c$`);

      await q(`ALTER TABLE legal.inspection_items
        ADD COLUMN IF NOT EXISTS room_code varchar(60) NULL,
        ADD COLUMN IF NOT EXISTS item_code varchar(60) NULL,
        ADD COLUMN IF NOT EXISTS description text NULL`);
      await q(`DO $c$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspection_items_condition_livro_chk') THEN
          ALTER TABLE legal.inspection_items ADD CONSTRAINT inspection_items_condition_livro_chk
            CHECK (condition IS NULL OR condition IN ('NEW','GOOD','REGULAR','DAMAGED')) NOT VALID;
        END IF;
      END $c$`);
      await q('ALTER TABLE legal.inspection_signatures ADD COLUMN IF NOT EXISTS snapshot_hash varchar(64) NULL');

      await q(`CREATE TABLE IF NOT EXISTS legal.inspection_media (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL,
        company_id uuid NOT NULL,
        inspection_id uuid NOT NULL REFERENCES legal.inspections(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        item_id uuid NOT NULL REFERENCES legal.inspection_items(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        file_id uuid NOT NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        sha256 varchar(64) NOT NULL,
        captured_at timestamptz NOT NULL DEFAULT now(),
        media_type varchar(16) NOT NULL CHECK (media_type IN ('PHOTO','VIDEO')),
        file_link_id uuid NULL,
        created_by uuid NULL,
        updated_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT inspection_media_item_file_uq UNIQUE (item_id, file_id)
      )`);
      await q('CREATE INDEX IF NOT EXISTS inspection_media_inspection_idx ON legal.inspection_media (company_id, inspection_id)');
      await applyLegalTenantRls(q, 'legal.inspection_media', 'SELECT, INSERT');
      // Mídias já ligadas pelo vínculo genérico (people.file_links) entram na tabela do livro.
      await q(`INSERT INTO legal.inspection_media (group_id, company_id, inspection_id, item_id, file_id, sha256, captured_at, media_type, file_link_id, created_by)
        SELECT fl.group_id, fl.company_id, it.inspection_id, it.id, f.id, f.checksum_sha256, fl.created_at, CASE WHEN fl.purpose = 'VIDEO' THEN 'VIDEO' ELSE 'PHOTO' END, fl.id, fl.created_by
          FROM people.file_links fl
          JOIN legal.inspection_items it ON it.id = fl.related_entity_id
          JOIN people.files f ON f.id = fl.file_id
         WHERE fl.related_entity_type = 'InspectionItem' AND fl.deleted_at IS NULL AND f.checksum_sha256 IS NOT NULL
        ON CONFLICT (item_id, file_id) DO NOTHING`);
      // NOT VALID só enquanto houver linha antiga fora da regra (src/shared/db/validarSeLimpo.js).
      await validarSeLimpo(q, 'legal.inspections', 'inspections_type_livro_chk', '20260101009991');
      await validarSeLimpo(q, 'legal.inspection_items', 'inspection_items_condition_livro_chk', '20260101009991');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TABLE IF EXISTS legal.inspection_media');
      await q('ALTER TABLE legal.inspection_signatures DROP COLUMN IF EXISTS snapshot_hash');
      await q('ALTER TABLE legal.inspection_items DROP CONSTRAINT IF EXISTS inspection_items_condition_livro_chk');
      await q('ALTER TABLE legal.inspection_items DROP COLUMN IF EXISTS room_code, DROP COLUMN IF EXISTS item_code, DROP COLUMN IF EXISTS description');
      await q('ALTER TABLE legal.inspections DROP CONSTRAINT IF EXISTS inspections_type_livro_chk');
      await q('DROP TRIGGER IF EXISTS inspections_type_do_livro ON legal.inspections');
      await q('DROP FUNCTION IF EXISTS legal.inspection_type_do_livro()');
      await q(`UPDATE legal.inspections SET inspection_type = CASE inspection_type WHEN 'ENTRY' THEN 'CHECK_IN' WHEN 'EXIT' THEN 'CHECK_OUT' WHEN 'INTERMEDIATE' THEN 'PERIODIC' ELSE inspection_type END`);
    });
  },
};
