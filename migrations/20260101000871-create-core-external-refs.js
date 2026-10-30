'use strict';

/**
 * M9-D906 — core.external_refs: o ID do sistema antigo preservado, ligado ao registro novo, com início e fim de validade. Nunca se apaga: o gatilho
 * recusa DELETE e só deixa fechar a vigência (valid_to nulo -> data) e trocar is_primary; qualquer outra mudança é recusada.
 * UNIQUE parcial 1: um ID legado vigente aponta para uma só entidade (empresa + sistema + tipo + chave). UNIQUE parcial 2: a entidade tem UM ID primário
 * vigente por sistema (pode ter outros, não primários, vindos de duplicatas unidas). RLS + FORCE por empresa; GRANT ao runtime sem DELETE, só se o role existir.
 * migration_run_id fica sem FK aqui (a tabela de execuções nasce na migration 873, que acrescenta a FK). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS core.external_refs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        entity_type varchar(30) NOT NULL,
        entity_id uuid NOT NULL,
        source_system varchar(40) NOT NULL,
        source_key varchar(128) NOT NULL,
        is_primary boolean NOT NULL DEFAULT true,
        valid_from timestamptz NOT NULL DEFAULT now(),
        valid_to timestamptz NULL,
        migration_run_id uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT core_extref_entity_chk CHECK (entity_type IN ('PERSON', 'PROPERTY', 'SUPPLIER', 'CONTRACT', 'FINANCIAL_ENTRY', 'LEAD', 'VISIT', 'PROPOSAL', 'PROJECT', 'PROJECT_STAGE', 'LEGAL_CASE', 'LEGAL_DEADLINE')),
        CONSTRAINT core_extref_key_chk CHECK (length(btrim(source_key)) > 0 AND source_key = btrim(source_key)),
        CONSTRAINT core_extref_period_chk CHECK (valid_to IS NULL OR valid_to >= valid_from)
      )`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS core_extref_key_uq ON core.external_refs (company_id, source_system, entity_type, source_key) WHERE valid_to IS NULL`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS core_extref_primary_uq ON core.external_refs (entity_id, source_system) WHERE valid_to IS NULL AND is_primary`);
      await q('CREATE INDEX IF NOT EXISTS core_extref_entity_idx ON core.external_refs (company_id, entity_id)');
      await q('CREATE INDEX IF NOT EXISTS core_extref_lookup_idx ON core.external_refs (company_id, source_system, source_key, valid_from)');
      await q(`CREATE OR REPLACE FUNCTION core.external_refs_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'external_refs é imutável: encerre a vigência em vez de apagar' USING ERRCODE = '23000';
          END IF;
          IF NEW.id IS DISTINCT FROM OLD.id OR NEW.group_id IS DISTINCT FROM OLD.group_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
             OR NEW.entity_type IS DISTINCT FROM OLD.entity_type OR NEW.entity_id IS DISTINCT FROM OLD.entity_id OR NEW.source_system IS DISTINCT FROM OLD.source_system
             OR NEW.source_key IS DISTINCT FROM OLD.source_key OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.created_at IS DISTINCT FROM OLD.created_at
             OR NEW.migration_run_id IS DISTINCT FROM OLD.migration_run_id OR (OLD.valid_to IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to) THEN
            RAISE EXCEPTION 'external_refs é imutável: só a vigência pode ser encerrada' USING ERRCODE = '23000';
          END IF;
          RETURN NEW;
        END $fn$`);
      await q('DROP TRIGGER IF EXISTS external_refs_guard ON core.external_refs');
      await q('CREATE TRIGGER external_refs_guard BEFORE UPDATE OR DELETE ON core.external_refs FOR EACH ROW EXECUTE FUNCTION core.external_refs_guard()');
      await q('ALTER TABLE core.external_refs ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE core.external_refs FORCE ROW LEVEL SECURITY');
      await q(`DO $do$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'core.external_refs'::regclass AND polname = 'tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON core.external_refs
            USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
            WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE ON core.external_refs TO nayara_runtime;
        END IF;
      END $do$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS core.external_refs');
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS core.external_refs_guard()');
  },
};
