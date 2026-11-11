'use strict';

const { applyLegalTenantRls } = require('./_helpers/legalTenantTable');

/**
 * Matriz M5 (Caderno §4 "legal.template_versions | Versões do modelo", §6 "Modelo publicado não é editado;
 * nova versão é criada", "Versão gerada do contrato guarda template_version_id", JUR-002 responsável jurídico).
 *  - legal.template_versions: versão numerada do modelo (DRAFT | PUBLISHED | SUPERSEDED), com responsável
 *    jurídico, publicador e data. Uma única DRAFT por modelo. Gatilho: só DRAFT -> PUBLISHED (com publicador)
 *    e PUBLISHED -> SUPERSEDED; nada mais muda.
 *  - legal.contract_template_clauses pertence a uma versão (template_version_id). Gatilho: vínculo de versão
 *    que não é DRAFT não é incluído, alterado nem removido.
 *  - legal.contract_templates ganha legal_responsible_user_id.
 *  - legal.contract_versions.template_version_id ganha a FK.
 *  - Legado: cada modelo existente vira a versão 1 PUBLISHED com os vínculos que já tinha; versões de contrato
 *    geradas de um modelo apontam para essa versão 1. Reversível.
 */
const GUARDS = `
  CREATE OR REPLACE FUNCTION legal.template_versions_guard_update() RETURNS trigger AS $$
  BEGIN
    IF (to_jsonb(NEW) - ARRAY['status','published_by','published_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','published_by','published_at','updated_at']) THEN
      RAISE EXCEPTION 'legal.template_versions: a versão % do modelo % não é editada (crie uma nova versão).', OLD.version_number, OLD.template_id USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      IF NOT (
        (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED' AND OLD.published_at IS NULL AND NEW.published_by IS NOT NULL AND NEW.published_at IS NOT NULL)
        OR (OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED' AND NEW.published_by IS NOT DISTINCT FROM OLD.published_by AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at)
      ) THEN
        RAISE EXCEPTION 'legal.template_versions: a versão % do modelo % só vai de DRAFT para PUBLISHED (uma vez) e de PUBLISHED para SUPERSEDED.', OLD.version_number, OLD.template_id USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION legal.template_clauses_guard_version() RETURNS trigger AS $$
  DECLARE v_status text;
  BEGIN
    SELECT status INTO v_status FROM legal.template_versions WHERE id = COALESCE(CASE WHEN TG_OP = 'DELETE' THEN OLD.template_version_id ELSE NEW.template_version_id END, OLD.template_version_id);
    IF v_status IS DISTINCT FROM 'DRAFT' OR (TG_OP = 'UPDATE' AND OLD.template_version_id IS DISTINCT FROM NEW.template_version_id) THEN
      RAISE EXCEPTION 'legal.contract_template_clauses: a versão publicada do modelo não é editada (crie uma nova versão do modelo).' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql;
`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS legal.template_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        template_id uuid NOT NULL REFERENCES legal.contract_templates(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        version_number integer NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'DRAFT',
        legal_responsible_user_id uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        published_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        published_at timestamptz NULL,
        created_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT template_versions_number_uq UNIQUE (template_id, version_number),
        CONSTRAINT template_versions_status_chk CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED')),
        CONSTRAINT template_versions_published_chk CHECK (status = 'DRAFT' OR published_at IS NOT NULL)
      )`);
      await q("CREATE UNIQUE INDEX IF NOT EXISTS template_versions_one_draft_uidx ON legal.template_versions (template_id) WHERE status = 'DRAFT'");
      await applyLegalTenantRls(q, 'legal.template_versions');
      await q('ALTER TABLE legal.contract_templates ADD COLUMN IF NOT EXISTS legal_responsible_user_id uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT');
      await q('UPDATE legal.contract_templates SET legal_responsible_user_id = created_by WHERE legal_responsible_user_id IS NULL AND created_by IS NOT NULL');
      await q('ALTER TABLE legal.contract_template_clauses ADD COLUMN IF NOT EXISTS template_version_id uuid NULL REFERENCES legal.template_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT');

      await q(`INSERT INTO legal.template_versions (group_id, company_id, template_id, version_number, status, legal_responsible_user_id, published_by, published_at, created_by, created_at)
        SELECT t.group_id, t.company_id, t.id, 1, 'PUBLISHED', t.legal_responsible_user_id, t.created_by, t.created_at, t.created_by, t.created_at
          FROM legal.contract_templates t WHERE NOT EXISTS (SELECT 1 FROM legal.template_versions v WHERE v.template_id = t.id)`);
      await q(`UPDATE legal.contract_template_clauses l SET template_version_id = v.id
          FROM legal.template_versions v WHERE v.template_id = l.contract_template_id AND v.version_number = 1 AND l.template_version_id IS NULL`);
      await q('ALTER TABLE legal.contract_template_clauses ALTER COLUMN template_version_id SET NOT NULL');
      await q('ALTER TABLE legal.contract_template_clauses DROP CONSTRAINT IF EXISTS contract_template_clauses_template_clause_unique');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS contract_template_clauses_version_clause_uidx ON legal.contract_template_clauses (template_version_id, contract_clause_id)');

      await q('ALTER TABLE legal.contract_versions DISABLE TRIGGER contract_versions_append_only');
      await q(`UPDATE legal.contract_versions cv SET template_version_id = v.id
          FROM legal.template_versions v WHERE v.template_id = cv.template_id AND v.version_number = 1 AND cv.template_version_id IS NULL`);
      await q('ALTER TABLE legal.contract_versions ENABLE TRIGGER contract_versions_append_only');
      await q(`DO $c$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_versions_template_version_fk') THEN
          ALTER TABLE legal.contract_versions ADD CONSTRAINT contract_versions_template_version_fk FOREIGN KEY (template_version_id) REFERENCES legal.template_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT;
        END IF;
      END $c$`);

      await q(GUARDS);
      await q('DROP TRIGGER IF EXISTS template_versions_guard ON legal.template_versions');
      await q('CREATE TRIGGER template_versions_guard BEFORE UPDATE ON legal.template_versions FOR EACH ROW EXECUTE FUNCTION legal.template_versions_guard_update()');
      await q('DROP TRIGGER IF EXISTS template_clauses_version_guard ON legal.contract_template_clauses');
      await q('CREATE TRIGGER template_clauses_version_guard BEFORE INSERT OR UPDATE OR DELETE ON legal.contract_template_clauses FOR EACH ROW EXECUTE FUNCTION legal.template_clauses_guard_version()');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TRIGGER IF EXISTS template_clauses_version_guard ON legal.contract_template_clauses');
      await q('ALTER TABLE legal.contract_versions DROP CONSTRAINT IF EXISTS contract_versions_template_version_fk');
      await q('DROP INDEX IF EXISTS legal.contract_template_clauses_version_clause_uidx');
      await q('DELETE FROM legal.contract_template_clauses a USING legal.contract_template_clauses b WHERE a.contract_template_id = b.contract_template_id AND a.contract_clause_id = b.contract_clause_id AND a.created_at < b.created_at');
      await q('ALTER TABLE legal.contract_template_clauses ADD CONSTRAINT contract_template_clauses_template_clause_unique UNIQUE (contract_template_id, contract_clause_id)');
      await q('ALTER TABLE legal.contract_template_clauses DROP COLUMN IF EXISTS template_version_id');
      await q('ALTER TABLE legal.contract_templates DROP COLUMN IF EXISTS legal_responsible_user_id');
      await q('DROP TABLE IF EXISTS legal.template_versions');
      await q('DROP FUNCTION IF EXISTS legal.template_versions_guard_update()');
      await q('DROP FUNCTION IF EXISTS legal.template_clauses_guard_version()');
    });
  },
};
