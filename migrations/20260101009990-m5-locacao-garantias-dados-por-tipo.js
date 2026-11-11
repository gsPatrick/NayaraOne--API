'use strict';

/**
 * Fechamento M5 — Garantias locatícias com os códigos e os dados do livro (Caderno M5 §9):
 *  GUARANTOR (pessoas, documentos, vigência, aceite) · INSURANCE (provider/apólice, vigência, parcelas, renovação) ·
 *  SECURITY_DEPOSIT (valor de terceiro, vínculo financeiro, devolução/compensação) · CAPITALIZATION (documento,
 *  provider, vigência) · OTHER (fluxo configurado).
 *  - guarantee_type: os códigos antigos DEPOSIT/CAPITALIZATION_TITLE são migrados e, se um gravador legado ainda os
 *    mandar, um gatilho BEFORE os traduz antes do CHECK (o banco só guarda os cinco do livro).
 *  - colunas dos dados por tipo; finance_entry_id aponta para o recebimento da caução no Financeiro (o saldo continua
 *    só no Financeiro), único entre garantias não excluídas.
 * Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE OR REPLACE FUNCTION legal.guarantee_type_do_livro() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          NEW.guarantee_type := CASE upper(NEW.guarantee_type)
            WHEN 'DEPOSIT' THEN 'SECURITY_DEPOSIT' WHEN 'CAPITALIZATION_TITLE' THEN 'CAPITALIZATION'
            ELSE upper(NEW.guarantee_type) END;
          RETURN NEW;
        END $f$`);
      await q('DROP TRIGGER IF EXISTS guarantees_type_do_livro ON legal.guarantees');
      await q(`CREATE TRIGGER guarantees_type_do_livro BEFORE INSERT OR UPDATE OF guarantee_type ON legal.guarantees
        FOR EACH ROW EXECUTE FUNCTION legal.guarantee_type_do_livro()`);
      await q(`UPDATE legal.guarantees SET guarantee_type = guarantee_type WHERE guarantee_type IN ('DEPOSIT','CAPITALIZATION_TITLE')`);
      await q(`DO $c$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guarantees_type_livro_chk') THEN
          ALTER TABLE legal.guarantees ADD CONSTRAINT guarantees_type_livro_chk
            CHECK (guarantee_type IN ('GUARANTOR','INSURANCE','SECURITY_DEPOSIT','CAPITALIZATION','OTHER')) NOT VALID;
        END IF;
      END $c$`);
      await q(`ALTER TABLE legal.guarantees
        ADD COLUMN IF NOT EXISTS additional_guarantor_person_ids jsonb NULL,
        ADD COLUMN IF NOT EXISTS document_file_ids jsonb NULL,
        ADD COLUMN IF NOT EXISTS acceptance_file_id uuid NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS accepted_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS provider_name varchar(160) NULL,
        ADD COLUMN IF NOT EXISTS policy_number varchar(80) NULL,
        ADD COLUMN IF NOT EXISTS policy_file_id uuid NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS premium_installments jsonb NULL,
        ADD COLUMN IF NOT EXISTS annual_premium numeric(18,2) NULL,
        ADD COLUMN IF NOT EXISTS renewal_due_at date NULL,
        ADD COLUMN IF NOT EXISTS auto_renew boolean NULL,
        ADD COLUMN IF NOT EXISTS finance_entry_id uuid NULL REFERENCES finance.financial_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS holder_person_id uuid NULL REFERENCES people.persons(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS certificate_number varchar(80) NULL,
        ADD COLUMN IF NOT EXISTS certificate_file_id uuid NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS redemption_amount numeric(18,2) NULL,
        ADD COLUMN IF NOT EXISTS homologated_flow_code varchar(60) NULL,
        ADD COLUMN IF NOT EXISTS flow_data jsonb NULL,
        ADD COLUMN IF NOT EXISTS notes text NULL`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS guarantees_finance_entry_uq ON legal.guarantees (finance_entry_id)
        WHERE finance_entry_id IS NOT NULL AND deleted_at IS NULL`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS guarantees_policy_uq ON legal.guarantees (company_id, lower(provider_name), policy_number)
        WHERE policy_number IS NOT NULL AND deleted_at IS NULL`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP INDEX IF EXISTS legal.guarantees_policy_uq');
      await q('DROP INDEX IF EXISTS legal.guarantees_finance_entry_uq');
      await q(`ALTER TABLE legal.guarantees
        DROP COLUMN IF EXISTS additional_guarantor_person_ids, DROP COLUMN IF EXISTS document_file_ids, DROP COLUMN IF EXISTS acceptance_file_id,
        DROP COLUMN IF EXISTS accepted_at, DROP COLUMN IF EXISTS provider_name, DROP COLUMN IF EXISTS policy_number, DROP COLUMN IF EXISTS policy_file_id,
        DROP COLUMN IF EXISTS premium_installments, DROP COLUMN IF EXISTS annual_premium, DROP COLUMN IF EXISTS renewal_due_at, DROP COLUMN IF EXISTS auto_renew,
        DROP COLUMN IF EXISTS finance_entry_id, DROP COLUMN IF EXISTS holder_person_id, DROP COLUMN IF EXISTS certificate_number,
        DROP COLUMN IF EXISTS certificate_file_id, DROP COLUMN IF EXISTS redemption_amount, DROP COLUMN IF EXISTS homologated_flow_code,
        DROP COLUMN IF EXISTS flow_data, DROP COLUMN IF EXISTS notes`);
      await q('ALTER TABLE legal.guarantees DROP CONSTRAINT IF EXISTS guarantees_type_livro_chk');
      await q('DROP TRIGGER IF EXISTS guarantees_type_do_livro ON legal.guarantees');
      await q('DROP FUNCTION IF EXISTS legal.guarantee_type_do_livro()');
      await q(`UPDATE legal.guarantees SET guarantee_type = CASE guarantee_type WHEN 'SECURITY_DEPOSIT' THEN 'DEPOSIT' WHEN 'CAPITALIZATION' THEN 'CAPITALIZATION_TITLE' ELSE guarantee_type END`);
    });
  },
};
