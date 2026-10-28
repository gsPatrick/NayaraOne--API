'use strict';

/**
 * Marco 9, demanda M9-D600 (Caderno "Dashboards + BI + Centro de Comando", entidades
 * analytics.metric_definitions, metric_versions e metric_snapshots; BI-007 e BI-008).
 *
 * Cria o schema "analytics" e o núcleo de métricas:
 *   - metric_definitions: o cadastro do indicador (uma linha por código e escopo);
 *   - metric_versions: versões IMUTÁVEIS da fórmula (gatilho recusa UPDATE/DELETE; só fecha valid_until
 *     ou sobe "revision"); vigências da mesma métrica nunca se sobrepõem (EXCLUDE USING gist);
 *   - metric_snapshots: fotografia do valor por data-base; nenhuma linha sofre UPDATE, a correção grava
 *     revision_no + 1 (rebuild auditado, M9-D608).
 *
 * Escopo das linhas (mesma regra nas 3 tabelas):
 *   - company_id preenchido: dado de uma empresa;
 *   - company_id nulo e group_id preenchido: dado de grupo/consolidado (group_scoped nas definições);
 *   - ambos nulos (só definições e versões): catálogo global do sistema, legível por todos.
 *
 * RLS ENABLE + FORCE nas 3 tabelas. Leitura pelas GUCs app.company_id / app.group_id; escrita SOMENTE
 * com app.analytics_writer = 'on' (worker de BI), nunca pelo caminho de requisição comum.
 *
 * Tudo em SQL puro e idempotente (roda duas vezes sem erro). Faixa de migrations do BI: 9600 a 9609.
 * O down não apaga dado de outros schemas e só remove o schema "analytics" se ele ficar vazio.
 */

const SCHEMA = 'analytics';

const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";

const READ_CATALOG = `((company_id IS NULL AND group_id IS NULL) OR company_id = ${COMPANY_GUC} OR (company_id IS NULL AND group_id = ${GROUP_GUC}))`;
const READ_TENANT = `(company_id = ${COMPANY_GUC} OR (company_id IS NULL AND group_id = ${GROUP_GUC}))`;

const UNITS = ['BRL', 'PERCENT', 'COUNT', 'DAYS', 'HOURS', 'MINUTES', 'SECONDS', 'SCORE', 'NUMBER', 'PP', 'BRL_PER_UNIT'];
const DOMAINS = [
  'FINANCE', 'CRM', 'PROPERTIES', 'RENTAL', 'CONSTRUCTION', 'INVENTORY', 'LEGAL', 'CORRESPONDENT',
  'MARKETING', 'SUPPORT', 'TECH_AI',
];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

async function applyRls(q, table, readExpr) {
  await q(`ALTER TABLE "${SCHEMA}"."${table}" ENABLE ROW LEVEL SECURITY`);
  await q(`ALTER TABLE "${SCHEMA}"."${table}" FORCE ROW LEVEL SECURITY`);
  for (const name of ['analytics_select', 'analytics_insert', 'analytics_update', 'analytics_delete']) {
    await q(`DROP POLICY IF EXISTS ${name} ON "${SCHEMA}"."${table}"`);
  }
  await q(`CREATE POLICY analytics_select ON "${SCHEMA}"."${table}" FOR SELECT USING (${readExpr})`);
  await q(`CREATE POLICY analytics_insert ON "${SCHEMA}"."${table}" FOR INSERT WITH CHECK (${WRITER_ON} AND ${readExpr})`);
  await q(`CREATE POLICY analytics_update ON "${SCHEMA}"."${table}" FOR UPDATE USING (${WRITER_ON} AND ${readExpr}) WITH CHECK (${WRITER_ON} AND ${readExpr})`);
  await q(`CREATE POLICY analytics_delete ON "${SCHEMA}"."${table}" FOR DELETE USING (${WRITER_ON} AND ${readExpr})`);
}

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    // Necessária para o EXCLUDE de vigências (igualdade de uuid dentro de índice gist).
    await q('CREATE EXTENSION IF NOT EXISTS btree_gist');

    // ---------------------------------------------------------------- metric_definitions
    await q(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."metric_definitions" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        group_id uuid NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        metric_code text NOT NULL,
        name text NOT NULL,
        description text NULL,
        domain text NOT NULL,
        current_version_id uuid NULL,
        status text NOT NULL DEFAULT 'DRAFT',
        criticality text NOT NULL DEFAULT 'NORMAL',
        owner_role text NULL,
        group_scoped boolean NOT NULL DEFAULT false,
        created_by uuid NULL,
        updated_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT metric_definitions_code_format CHECK (metric_code ~ '^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$'),
        CONSTRAINT metric_definitions_domain_valid CHECK (domain IN (${list(DOMAINS)})),
        CONSTRAINT metric_definitions_status_valid CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
        CONSTRAINT metric_definitions_criticality_valid CHECK (criticality IN ('CRITICAL', 'NORMAL')),
        CONSTRAINT metric_definitions_scope_valid CHECK (
          group_scoped = (company_id IS NULL AND group_id IS NOT NULL)
        ),
        CONSTRAINT metric_definitions_name_not_blank CHECK (length(btrim(name)) > 0)
      )
    `);
    await q(`
      CREATE UNIQUE INDEX IF NOT EXISTS metric_definitions_code_scope_uq
        ON "${SCHEMA}"."metric_definitions" (
          COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid),
          COALESCE(group_id, '00000000-0000-0000-0000-000000000000'::uuid),
          metric_code
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS metric_definitions_domain_idx ON "${SCHEMA}"."metric_definitions" (domain, status)`);

    // ---------------------------------------------------------------- metric_versions
    await q(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."metric_versions" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        group_id uuid NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        metric_id uuid NOT NULL REFERENCES "${SCHEMA}"."metric_definitions"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        version integer NOT NULL,
        formula_id text NOT NULL,
        formula_semantic text NOT NULL,
        source_read_model text NULL,
        dimensions jsonb NOT NULL DEFAULT '[]'::jsonb,
        filters jsonb NOT NULL DEFAULT '{}'::jsonb,
        unit text NOT NULL,
        refresh_policy jsonb NOT NULL,
        quality_rule jsonb NULL,
        value_nature text NOT NULL,
        formula_test_hash char(64) NULL,
        revision integer NOT NULL DEFAULT 0,
        valid_from date NOT NULL,
        valid_until date NULL,
        published_by uuid NULL,
        published_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        change_reason text NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT metric_versions_metric_version_uq UNIQUE (metric_id, version),
        CONSTRAINT metric_versions_version_positive CHECK (version >= 1),
        CONSTRAINT metric_versions_unit_valid CHECK (unit IN (${list(UNITS)})),
        CONSTRAINT metric_versions_value_nature_valid CHECK (value_nature IN ('ACTUAL', 'PLANNED', 'ESTIMATED', 'PROJECTED')),
        CONSTRAINT metric_versions_refresh_policy_valid CHECK (
          jsonb_typeof(refresh_policy) = 'object' AND refresh_policy->>'mode' IN ('EVENT', 'SCHEDULE')
        ),
        CONSTRAINT metric_versions_formula_test_hash_format CHECK (formula_test_hash IS NULL OR formula_test_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT metric_versions_revision_nonneg CHECK (revision >= 0),
        CONSTRAINT metric_versions_validity_order CHECK (valid_until IS NULL OR valid_until > valid_from),
        CONSTRAINT metric_versions_change_reason_required CHECK (
          version = 1 OR (change_reason IS NOT NULL AND length(btrim(change_reason)) > 0)
        ),
        CONSTRAINT metric_versions_no_overlap EXCLUDE USING gist (
          metric_id WITH =,
          daterange(valid_from, valid_until, '[)') WITH &&
        )
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS metric_versions_metric_idx ON "${SCHEMA}"."metric_versions" (metric_id, valid_from DESC)`);

    // Ponteiro da versão publicada (a FK fecha o ciclo definições <-> versões).
    await q(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'metric_definitions_current_version_fk') THEN
          ALTER TABLE "${SCHEMA}"."metric_definitions"
            ADD CONSTRAINT metric_definitions_current_version_fk
            FOREIGN KEY (current_version_id) REFERENCES "${SCHEMA}"."metric_versions"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;
      END $$;
    `);

    // ---------------------------------------------------------------- metric_snapshots
    await q(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."metric_snapshots" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        metric_id uuid NOT NULL REFERENCES "${SCHEMA}"."metric_definitions"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        metric_version_id uuid NOT NULL REFERENCES "${SCHEMA}"."metric_versions"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        scope_type text NOT NULL,
        scope_id uuid NOT NULL,
        dimension_key text NOT NULL DEFAULT '',
        period_start date NOT NULL,
        period_end date NOT NULL,
        as_of_date date NOT NULL,
        value_numeric numeric(20,4) NULL,
        value_text text NULL,
        status text NOT NULL,
        source_snapshot_at timestamptz NULL,
        refreshed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        read_model_version integer NULL,
        source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
        calc_hash char(64) NOT NULL,
        revision_no integer NOT NULL DEFAULT 1,
        recalculated boolean NOT NULL DEFAULT false,
        captured_late boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT metric_snapshots_key_uq UNIQUE (
          metric_id, metric_version_id, scope_type, scope_id, dimension_key, period_start, period_end, as_of_date, revision_no
        ),
        CONSTRAINT metric_snapshots_status_valid CHECK (status IN ('OK', 'STALE', 'DEGRADED', 'INCOMPLETE')),
        CONSTRAINT metric_snapshots_scope_type_format CHECK (scope_type ~ '^[A-Z][A-Z0-9_]*$'),
        CONSTRAINT metric_snapshots_calc_hash_format CHECK (calc_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT metric_snapshots_period_order CHECK (period_end >= period_start),
        CONSTRAINT metric_snapshots_revision_valid CHECK (revision_no >= 1 AND (revision_no = 1 OR recalculated)),
        CONSTRAINT metric_snapshots_group_scope_valid CHECK ((scope_type = 'GROUP') = (company_id IS NULL))
      )
    `);
    await q(`
      CREATE INDEX IF NOT EXISTS metric_snapshots_lookup_idx
        ON "${SCHEMA}"."metric_snapshots" (metric_id, scope_type, scope_id, as_of_date DESC, revision_no DESC)
    `);
    await q(`CREATE INDEX IF NOT EXISTS metric_snapshots_company_idx ON "${SCHEMA}"."metric_snapshots" (company_id, as_of_date)`);

    // ---------------------------------------------------------------- gatilhos de imutabilidade
    await q(`
      CREATE OR REPLACE FUNCTION "${SCHEMA}".metric_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
      DECLARE
        last_version integer;
        def RECORD;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Versão publicada não pode ser removida. Publique uma nova versão.' USING ERRCODE = 'ANA01';
        ELSIF TG_OP = 'UPDATE' THEN
          -- Só a rotina de publicação fecha a vigência (nula -> data) e só "revision" pode subir.
          IF (to_jsonb(NEW) - ARRAY['valid_until', 'revision', 'updated_at'])
             IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['valid_until', 'revision', 'updated_at']) THEN
            RAISE EXCEPTION 'Versão publicada não pode ser alterada. Publique uma nova versão.' USING ERRCODE = 'ANA01';
          END IF;
          IF OLD.valid_until IS NOT NULL AND NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
            RAISE EXCEPTION 'Vigência já encerrada não pode ser alterada.' USING ERRCODE = 'ANA01';
          END IF;
          IF NEW.revision < OLD.revision THEN
            RAISE EXCEPTION 'A revisão da versão só pode subir.' USING ERRCODE = 'ANA01';
          END IF;
          RETURN NEW;
        END IF;

        -- INSERT: versões 1, 2, 3 ... sem buracos e com o mesmo escopo da definição.
        SELECT COALESCE(MAX(version), 0) INTO last_version FROM "${SCHEMA}"."metric_versions" WHERE metric_id = NEW.metric_id;
        IF NEW.version <> last_version + 1 THEN
          RAISE EXCEPTION 'Numeração de versão inválida: esperada %, recebida %.', last_version + 1, NEW.version USING ERRCODE = 'ANA02';
        END IF;
        SELECT company_id, group_id INTO def FROM "${SCHEMA}"."metric_definitions" WHERE id = NEW.metric_id;
        IF NOT FOUND OR def.company_id IS DISTINCT FROM NEW.company_id OR def.group_id IS DISTINCT FROM NEW.group_id THEN
          RAISE EXCEPTION 'A versão precisa ter o mesmo escopo da definição da métrica.' USING ERRCODE = 'ANA04';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await q(`DROP TRIGGER IF EXISTS metric_versions_guard ON "${SCHEMA}"."metric_versions"`);
    await q(`
      CREATE TRIGGER metric_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON "${SCHEMA}"."metric_versions"
        FOR EACH ROW EXECUTE FUNCTION "${SCHEMA}".metric_versions_guard()
    `);

    await q(`
      CREATE OR REPLACE FUNCTION "${SCHEMA}".metric_snapshots_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'Snapshot é imutável. Para corrigir, grave uma nova revisão (rebuild auditado).' USING ERRCODE = 'ANA03';
      END
      $fn$
    `);
    await q(`DROP TRIGGER IF EXISTS metric_snapshots_guard ON "${SCHEMA}"."metric_snapshots"`);
    await q(`
      CREATE TRIGGER metric_snapshots_guard BEFORE UPDATE ON "${SCHEMA}"."metric_snapshots"
        FOR EACH ROW EXECUTE FUNCTION "${SCHEMA}".metric_snapshots_guard()
    `);

    // Integridade de escopo (empresa x grupo x usuário), nas 3 tabelas, no INSERT:
    //   - empresa informada precisa existir no grupo informado (core.companies, sob a RLS de quem grava: empresa de
    //     outro grupo é invisível e cai aqui);
    //   - se há contexto de usuário (GUC), a empresa/grupo gravados precisam ser os do contexto;
    //   - snapshot: a versão é da métrica informada e a métrica é do mesmo escopo (ou catálogo global).
    // ANA05 = escopo inexistente ou sem acesso (404 ANALYTICS_SCOPE_NOT_FOUND); ANA06 = versão de outra métrica.
    await q(`
      CREATE OR REPLACE FUNCTION "${SCHEMA}".analytics_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
      DECLARE
        ctx_company uuid := NULLIF(current_setting('app.company_id', true), '')::uuid;
        ctx_group uuid := NULLIF(current_setting('app.group_id', true), '')::uuid;
        def RECORD;
        ver_metric uuid;
      BEGIN
        IF NEW.company_id IS NOT NULL THEN
          IF NEW.group_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM "core"."companies" c WHERE c.id = NEW.company_id AND c.group_id = NEW.group_id
          ) THEN
            RAISE EXCEPTION 'Empresa não encontrada ou sem acesso.' USING ERRCODE = 'ANA05';
          END IF;
          IF ctx_company IS NOT NULL AND NEW.company_id <> ctx_company THEN
            RAISE EXCEPTION 'Empresa não encontrada ou sem acesso.' USING ERRCODE = 'ANA05';
          END IF;
        END IF;
        IF NEW.group_id IS NOT NULL AND ctx_group IS NOT NULL AND NEW.group_id <> ctx_group THEN
          RAISE EXCEPTION 'Empresa não encontrada ou sem acesso.' USING ERRCODE = 'ANA05';
        END IF;
        IF NEW.company_id IS NULL AND NEW.group_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM "core"."groups" g WHERE g.id = NEW.group_id) THEN
          RAISE EXCEPTION 'Empresa não encontrada ou sem acesso.' USING ERRCODE = 'ANA05';
        END IF;
        IF TG_TABLE_NAME = 'metric_snapshots' THEN
          SELECT company_id, group_id INTO def FROM "${SCHEMA}"."metric_definitions" WHERE id = NEW.metric_id;
          IF NOT FOUND
             OR (def.company_id IS NOT NULL AND def.company_id IS DISTINCT FROM NEW.company_id)
             OR (def.group_id IS NOT NULL AND def.group_id IS DISTINCT FROM NEW.group_id) THEN
            RAISE EXCEPTION 'Empresa não encontrada ou sem acesso.' USING ERRCODE = 'ANA05';
          END IF;
          SELECT metric_id INTO ver_metric FROM "${SCHEMA}"."metric_versions" WHERE id = NEW.metric_version_id;
          IF ver_metric IS DISTINCT FROM NEW.metric_id THEN
            RAISE EXCEPTION 'A versão informada não pertence a esta métrica.' USING ERRCODE = 'ANA06';
          END IF;
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    for (const table of ['metric_definitions', 'metric_versions', 'metric_snapshots']) {
      await q(`DROP TRIGGER IF EXISTS analytics_scope_guard ON "${SCHEMA}"."${table}"`);
      await q(`
        CREATE TRIGGER analytics_scope_guard BEFORE INSERT ON "${SCHEMA}"."${table}"
          FOR EACH ROW EXECUTE FUNCTION "${SCHEMA}".analytics_scope_guard()
      `);
    }

    // ---------------------------------------------------------------- RLS
    await applyRls(q, 'metric_definitions', READ_CATALOG);
    await applyRls(q, 'metric_versions', READ_CATALOG);
    await applyRls(q, 'metric_snapshots', READ_TENANT);

    // ---------------------------------------------------------------- GRANTs (só se a role existir)
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "${SCHEMA}" TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE, DELETE ON "${SCHEMA}"."metric_definitions", "${SCHEMA}"."metric_versions", "${SCHEMA}"."metric_snapshots" TO nayara_runtime;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_migration') THEN
            ALTER DEFAULT PRIVILEGES FOR ROLE nayara_migration IN SCHEMA "${SCHEMA}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nayara_runtime;
          END IF;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_migration') THEN
            ALTER DEFAULT PRIVILEGES FOR ROLE nayara_migration IN SCHEMA "${SCHEMA}" REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM nayara_runtime;
          END IF;
        END IF;
      END $$;
    `);
    await q(`DROP TABLE IF EXISTS "${SCHEMA}"."metric_snapshots"`);
    await q(`ALTER TABLE IF EXISTS "${SCHEMA}"."metric_definitions" DROP CONSTRAINT IF EXISTS metric_definitions_current_version_fk`);
    await q(`DROP TABLE IF EXISTS "${SCHEMA}"."metric_versions"`);
    await q(`DROP TABLE IF EXISTS "${SCHEMA}"."metric_definitions"`);
    await q(`DROP FUNCTION IF EXISTS "${SCHEMA}".metric_versions_guard()`);
    await q(`DROP FUNCTION IF EXISTS "${SCHEMA}".metric_snapshots_guard()`);
    await q(`DROP FUNCTION IF EXISTS "${SCHEMA}".analytics_scope_guard()`);
    // Só remove o schema se nada de outras demandas (D601, D602, rm_*) estiver dentro dele.
    await q(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${SCHEMA}'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '${SCHEMA}'
        ) THEN
          DROP SCHEMA IF EXISTS "${SCHEMA}";
        END IF;
      END $$;
    `);
  },
};
