'use strict';

const { applyLegalTenantRls } = require('./_helpers/legalTenantTable');

/**
 * Matriz M5 (Caderno §4 "legal.clause_library | Biblioteca de cláusulas" e "legal.clause_versions | Versões
 * homologadas"; JUR-002 "Cláusulas/modelos possuem versão e responsável jurídico").
 *  - legal.contract_clauses passa a se chamar legal.clause_versions (as versões; mesmas linhas, gatilho
 *    append-only, RLS e GRANTs acompanham o RENAME; sem visão de compatibilidade).
 *  - legal.clause_library: uma linha por cláusula (código) da empresa, com o responsável jurídico.
 *  - legal.clause_versions.clause_library_id (NOT NULL) com FK composta (clause_library_id, company_id, code)
 *    -> clause_library(id, company_id, code): o código da versão é a chave da biblioteca, não um dado solto.
 * Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE legal.contract_clauses RENAME TO clause_versions');
      await q(`CREATE TABLE IF NOT EXISTS legal.clause_library (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        code varchar(64) NOT NULL,
        legal_responsible_user_id uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        created_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT clause_library_code_uq UNIQUE (company_id, code),
        CONSTRAINT clause_library_key_uq UNIQUE (id, company_id, code)
      )`);
      await applyLegalTenantRls(q, 'legal.clause_library');
      await q(`INSERT INTO legal.clause_library (group_id, company_id, code, legal_responsible_user_id, created_by, created_at)
        SELECT DISTINCT ON (company_id, code) group_id, company_id, code, created_by, created_by, created_at
          FROM legal.clause_versions ORDER BY company_id, code, version_number ASC
        ON CONFLICT (company_id, code) DO NOTHING`);
      await q('ALTER TABLE legal.clause_versions ADD COLUMN IF NOT EXISTS clause_library_id uuid NULL');
      await q(`UPDATE legal.clause_versions v SET clause_library_id = l.id FROM legal.clause_library l
          WHERE l.company_id = v.company_id AND l.code = v.code AND v.clause_library_id IS NULL`);
      await q('ALTER TABLE legal.clause_versions ALTER COLUMN clause_library_id SET NOT NULL');
      await q(`DO $c$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clause_versions_library_fk') THEN
          ALTER TABLE legal.clause_versions ADD CONSTRAINT clause_versions_library_fk FOREIGN KEY (clause_library_id, company_id, code)
            REFERENCES legal.clause_library (id, company_id, code) ON UPDATE RESTRICT ON DELETE RESTRICT;
        END IF;
      END $c$`);
      await q('CREATE INDEX IF NOT EXISTS clause_versions_library_idx ON legal.clause_versions (clause_library_id, version_number)');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE legal.clause_versions DROP CONSTRAINT IF EXISTS clause_versions_library_fk');
      await q('DROP INDEX IF EXISTS legal.clause_versions_library_idx');
      await q('ALTER TABLE legal.clause_versions DROP COLUMN IF EXISTS clause_library_id');
      await q('DROP TABLE IF EXISTS legal.clause_library');
      await q('ALTER TABLE legal.clause_versions RENAME TO contract_clauses');
    });
  },
};
