'use strict';

const { applyLegalTenantRls } = require('./_helpers/legalTenantTable');

/**
 * Matriz M5 (Caderno §4 "legal.addenda | Aditivos", §13 "Aditivo referencia contrato e versão base" e "Motivo,
 * vigência, cláusulas alteradas e assinaturas ficam registrados"; M5-D102 rename sem visão de compatibilidade).
 *  - legal.contract_amendments -> legal.addenda (RLS, política e GRANTs acompanham o RENAME).
 *  - addenda ganha base_contract_version_id (versão base), effective_from/effective_until (vigência) e
 *    changed_clauses (cláusulas alteradas). Legado: versão base = última versão do contrato criada até o aditivo;
 *    vigência inicial = data de criação.
 *  - legal.addendum_signatures: uma assinatura por signatário do aditivo (pessoa, papel, via assinada, coletor,
 *    data), imutável (runtime só SELECT/INSERT). Assinatura de aditivo legado (sem signatário) fica como estava.
 * Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE legal.contract_amendments RENAME TO addenda');
      await q(`ALTER TABLE legal.addenda
        ADD COLUMN IF NOT EXISTS base_contract_version_id uuid NULL REFERENCES legal.contract_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS effective_from date NULL,
        ADD COLUMN IF NOT EXISTS effective_until date NULL,
        ADD COLUMN IF NOT EXISTS changed_clauses jsonb NOT NULL DEFAULT '[]'::jsonb`);
      await q(`UPDATE legal.addenda a SET base_contract_version_id = (
          SELECT v.id FROM legal.contract_versions v WHERE v.contract_id = a.contract_id AND v.created_at <= a.created_at ORDER BY v.version_number DESC LIMIT 1)
        WHERE a.base_contract_version_id IS NULL`);
      await q('UPDATE legal.addenda SET effective_from = created_at::date WHERE effective_from IS NULL');
      await q('ALTER TABLE legal.addenda ALTER COLUMN effective_from SET NOT NULL');
      await q(`DO $c$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'addenda_vigencia_chk') THEN
          ALTER TABLE legal.addenda ADD CONSTRAINT addenda_vigencia_chk CHECK (effective_until IS NULL OR effective_until >= effective_from);
        END IF;
      END $c$`);
      await q(`CREATE TABLE IF NOT EXISTS legal.addendum_signatures (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        addendum_id uuid NOT NULL REFERENCES legal.addenda(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        person_id uuid NOT NULL REFERENCES people.persons(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        party_role varchar(16) NOT NULL,
        evidence_file_id uuid NOT NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        collected_by_user_id uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        signed_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT addendum_signatures_signer_uq UNIQUE (addendum_id, person_id)
      )`);
      await applyLegalTenantRls(q, 'legal.addendum_signatures', 'SELECT, INSERT');
      await q(`CREATE OR REPLACE FUNCTION legal.addendum_signatures_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'legal.addendum_signatures é imutável: a assinatura do aditivo não é alterada nem removida.' USING ERRCODE = '42501';
      END; $$ LANGUAGE plpgsql`);
      await q('DROP TRIGGER IF EXISTS addendum_signatures_immutable ON legal.addendum_signatures');
      await q('CREATE TRIGGER addendum_signatures_immutable BEFORE UPDATE OR DELETE ON legal.addendum_signatures FOR EACH ROW EXECUTE FUNCTION legal.addendum_signatures_immutable()');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TABLE IF EXISTS legal.addendum_signatures');
      await q('DROP FUNCTION IF EXISTS legal.addendum_signatures_immutable()');
      await q(`ALTER TABLE legal.addenda DROP CONSTRAINT IF EXISTS addenda_vigencia_chk,
        DROP COLUMN IF EXISTS base_contract_version_id, DROP COLUMN IF EXISTS effective_from,
        DROP COLUMN IF EXISTS effective_until, DROP COLUMN IF EXISTS changed_clauses`);
      await q('ALTER TABLE legal.addenda RENAME TO contract_amendments');
    });
  },
};
