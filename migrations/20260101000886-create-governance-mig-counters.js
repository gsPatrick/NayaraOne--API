'use strict';

/**
 * M9-D901 — governance.mig_counters: contadores materializados da Torre de controle, um por empresa, sistema de origem, entidade e estado do registro (governance.mig_records).
 * Um gatilho AFTER INSERT/UPDATE/DELETE em mig_records soma e subtrai na MESMA transação do registro (UPDATE ... SET n = n + 1, atômico), de modo que nenhum escritor
 * (aplicador, decisão humana, verificação de lote) precisa lembrar de atualizar. A Torre compara os contadores com a contagem direta; o job de conferência os refaz.
 * RLS + FORCE pela função do alicerce; a carga inicial roda por empresa. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.mig_counters (
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        source_system varchar(40) NOT NULL,
        entity varchar(30) NOT NULL,
        state varchar(16) NOT NULL,
        n bigint NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (company_id, source_system, entity, state)
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.mig_counters'::regclass)");
      await q(`CREATE OR REPLACE FUNCTION governance.mig_records_count() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF TG_OP IN ('UPDATE', 'DELETE') THEN
            IF TG_OP = 'DELETE' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.source_system IS DISTINCT FROM NEW.source_system OR OLD.entity IS DISTINCT FROM NEW.entity THEN
              INSERT INTO governance.mig_counters AS c (group_id, company_id, source_system, entity, state, n) VALUES (OLD.group_id, OLD.company_id, OLD.source_system, OLD.entity, OLD.state, -1)
                ON CONFLICT (company_id, source_system, entity, state) DO UPDATE SET n = c.n - 1, updated_at = now();
            END IF;
          END IF;
          IF TG_OP IN ('INSERT', 'UPDATE') THEN
            IF TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.source_system IS DISTINCT FROM NEW.source_system OR OLD.entity IS DISTINCT FROM NEW.entity THEN
              INSERT INTO governance.mig_counters AS c (group_id, company_id, source_system, entity, state, n) VALUES (NEW.group_id, NEW.company_id, NEW.source_system, NEW.entity, NEW.state, 1)
                ON CONFLICT (company_id, source_system, entity, state) DO UPDATE SET n = c.n + 1, updated_at = now();
            END IF;
          END IF;
          RETURN NULL;
        END
        $fn$`);
      await q('DROP TRIGGER IF EXISTS mig_records_count_trg ON governance.mig_records');
      await q('CREATE TRIGGER mig_records_count_trg AFTER INSERT OR UPDATE OR DELETE ON governance.mig_records FOR EACH ROW EXECUTE FUNCTION governance.mig_records_count()');
      await q(`DO $do$
        DECLARE c record;
        BEGIN
          FOR c IN SELECT id FROM core.companies LOOP
            PERFORM set_config('app.company_id', c.id::text, true);
            INSERT INTO governance.mig_counters AS k (group_id, company_id, source_system, entity, state, n)
              SELECT group_id, company_id, source_system, entity, state, count(*) FROM governance.mig_records WHERE company_id = c.id GROUP BY group_id, company_id, source_system, entity, state
              ON CONFLICT (company_id, source_system, entity, state) DO UPDATE SET n = EXCLUDED.n, updated_at = now();
          END LOOP;
        END $do$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS mig_records_count_trg ON governance.mig_records');
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS governance.mig_records_count()');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.mig_counters');
  },
};
