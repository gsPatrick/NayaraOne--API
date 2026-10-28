'use strict';

/**
 * Marco 9, demanda M9-D601 (Caderno "Dashboards + BI + Centro de Comando", §3 Entidades):
 * analytics.dashboard_definitions, dashboard_widgets, executive_briefs e export_jobs.
 *
 * - dashboard_definitions: painel versionado (version+1 a cada mudança de widgets). Escopo igual ao de
 *   metric_definitions (empresa / grupo / catálogo global). Painel fora de DRAFT só muda de status.
 * - dashboard_widgets: blocos do painel; metric_code obrigatório nos tipos que mostram métrica; o gatilho
 *   recusa chave sql/formula/expression em config (em qualquer profundidade) e qualquer escrita em painel
 *   que não esteja em DRAFT.
 * - executive_briefs: briefing da NAY Diretoria; source_refs não vazio SEMPRE (CHECK); uma versão vigente
 *   por (empresa/grupo, tipo, período); depois de gravado só pode virar SUPERSEDED.
 * - export_jobs: escopo e filtros CONGELADOS por gatilho (ANA07). Escrita na transação da requisição do
 *   usuário (INSERT) com requested_by = usuário do contexto; o andamento (UPDATE) é do worker.
 *
 * Reaproveita analytics.analytics_scope_guard() da M9-D600 (empresa no grupo e no contexto -> ANA05).
 * RLS ENABLE + FORCE. Leitura pelas GUCs; escrita com app.analytics_writer = 'on', exceto o INSERT de
 * export_jobs. SQL puro e idempotente (roda duas vezes). Faixa de migrations do BI: 9600 a 9609.
 */

const SCHEMA = 'analytics';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const USER_GUC = "NULLIF(current_setting('app.user_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_CATALOG = `((company_id IS NULL AND group_id IS NULL) OR company_id = ${COMPANY_GUC} OR (company_id IS NULL AND group_id = ${GROUP_GUC}))`;
const READ_TENANT = `(company_id = ${COMPANY_GUC} OR (company_id IS NULL AND group_id = ${GROUP_GUC}))`;

const list = (values) => values.map((v) => `'${v}'`).join(', ');
const T = (name) => `"${SCHEMA}"."${name}"`;

async function applyRls(q, table, readExpr, insertExtra = WRITER_ON) {
  await q(`ALTER TABLE ${T(table)} ENABLE ROW LEVEL SECURITY`);
  await q(`ALTER TABLE ${T(table)} FORCE ROW LEVEL SECURITY`);
  for (const name of ['analytics_select', 'analytics_insert', 'analytics_update', 'analytics_delete']) {
    await q(`DROP POLICY IF EXISTS ${name} ON ${T(table)}`);
  }
  await q(`CREATE POLICY analytics_select ON ${T(table)} FOR SELECT USING (${readExpr})`);
  await q(`CREATE POLICY analytics_insert ON ${T(table)} FOR INSERT WITH CHECK (${insertExtra} AND ${readExpr})`);
  await q(`CREATE POLICY analytics_update ON ${T(table)} FOR UPDATE USING (${WRITER_ON} AND ${readExpr}) WITH CHECK (${WRITER_ON} AND ${readExpr})`);
  await q(`CREATE POLICY analytics_delete ON ${T(table)} FOR DELETE USING (${WRITER_ON} AND ${readExpr})`);
}

async function createDashboardTables(q) {
  await q(`
    CREATE TABLE IF NOT EXISTS ${T('dashboard_definitions')} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      group_id uuid NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      dashboard_code text NOT NULL,
      name text NOT NULL,
      description text NULL,
      domain text NOT NULL,
      audience_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
      layout jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'DRAFT',
      version integer NOT NULL DEFAULT 1,
      p95_target_ms integer NULL,
      required_permission text NOT NULL,
      published_at timestamptz NULL,
      created_by uuid NULL,
      updated_by uuid NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT dashboard_definitions_code_format CHECK (dashboard_code ~ '^[a-z][a-z0-9_]*$'),
      CONSTRAINT dashboard_definitions_status_valid CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
      CONSTRAINT dashboard_definitions_version_positive CHECK (version >= 1),
      CONSTRAINT dashboard_definitions_p95_positive CHECK (p95_target_ms IS NULL OR p95_target_ms > 0),
      CONSTRAINT dashboard_definitions_name_not_blank CHECK (length(btrim(name)) > 0),
      CONSTRAINT dashboard_definitions_permission_not_blank CHECK (length(btrim(required_permission)) > 0),
      CONSTRAINT dashboard_definitions_audience_array CHECK (jsonb_typeof(audience_roles) = 'array'),
      CONSTRAINT dashboard_definitions_layout_object CHECK (jsonb_typeof(layout) = 'object')
    )
  `);
  await q(`
    CREATE UNIQUE INDEX IF NOT EXISTS dashboard_definitions_code_version_uq ON ${T('dashboard_definitions')} (
      COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(group_id, '00000000-0000-0000-0000-000000000000'::uuid), dashboard_code, version)
  `);
  await q(`
    CREATE UNIQUE INDEX IF NOT EXISTS dashboard_definitions_one_published_uq ON ${T('dashboard_definitions')} (
      COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(group_id, '00000000-0000-0000-0000-000000000000'::uuid), dashboard_code) WHERE status = 'PUBLISHED'
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS ${T('dashboard_widgets')} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      group_id uuid NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      dashboard_id uuid NOT NULL REFERENCES ${T('dashboard_definitions')}(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      position integer NOT NULL,
      widget_type text NOT NULL,
      metric_code text NULL,
      dimension_key text NULL,
      title text NOT NULL,
      value_nature text NOT NULL DEFAULT 'ACTUAL',
      drilldown_enabled boolean NOT NULL DEFAULT false,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT dashboard_widgets_position_uq UNIQUE (dashboard_id, position),
      CONSTRAINT dashboard_widgets_position_nonneg CHECK (position >= 0),
      CONSTRAINT dashboard_widgets_type_valid CHECK (widget_type IN (${list(['KPI_CARD', 'TREND', 'TABLE', 'BAR', 'LIST_ALERTS', 'QUALITY_BANNER', 'BRIEF'])})),
      CONSTRAINT dashboard_widgets_nature_valid CHECK (value_nature IN ('ACTUAL', 'PLANNED', 'ESTIMATED', 'PROJECTED')),
      CONSTRAINT dashboard_widgets_metric_required CHECK (
        widget_type NOT IN ('KPI_CARD', 'TREND', 'TABLE', 'BAR') OR (metric_code IS NOT NULL AND length(btrim(metric_code)) > 0)
      ),
      CONSTRAINT dashboard_widgets_metric_code_format CHECK (metric_code IS NULL OR metric_code ~ '^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$'),
      CONSTRAINT dashboard_widgets_title_not_blank CHECK (length(btrim(title)) > 0),
      CONSTRAINT dashboard_widgets_config_object CHECK (jsonb_typeof(config) = 'object')
    )
  `);
}

async function createBriefAndExportTables(q) {
  await q(`
    CREATE TABLE IF NOT EXISTS ${T('executive_briefs')} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      brief_type text NOT NULL,
      period_start date NOT NULL,
      period_end date NOT NULL,
      generated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ai_run_id uuid NULL,
      status text NOT NULL,
      content jsonb NOT NULL DEFAULT '[]'::jsonb,
      source_refs jsonb NOT NULL,
      freshness_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      quality_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      blocked_reason text NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT executive_briefs_type_valid CHECK (brief_type IN ('DAILY', 'WEEKLY')),
      CONSTRAINT executive_briefs_status_valid CHECK (status IN ('GENERATED', 'BLOCKED_GROUNDING', 'FAILED', 'SUPERSEDED')),
      CONSTRAINT executive_briefs_period_order CHECK (period_end >= period_start),
      CONSTRAINT executive_briefs_sources_not_empty CHECK (jsonb_typeof(source_refs) = 'array' AND jsonb_array_length(source_refs) > 0),
      CONSTRAINT executive_briefs_content_valid CHECK (jsonb_typeof(content) IN ('array', 'object')),
      CONSTRAINT executive_briefs_summaries_object CHECK (jsonb_typeof(freshness_summary) = 'object' AND jsonb_typeof(quality_summary) = 'object'),
      CONSTRAINT executive_briefs_reason_required CHECK (
        status NOT IN ('BLOCKED_GROUNDING', 'FAILED') OR (blocked_reason IS NOT NULL AND length(btrim(blocked_reason)) > 0)
      )
    )
  `);
  await q(`
    CREATE UNIQUE INDEX IF NOT EXISTS executive_briefs_current_uq ON ${T('executive_briefs')} (
      COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), group_id, brief_type, period_start, period_end)
      WHERE status <> 'SUPERSEDED'
  `);
  await q(`CREATE INDEX IF NOT EXISTS executive_briefs_lookup_idx ON ${T('executive_briefs')} (company_id, brief_type, period_end DESC)`);
  await q(`
    CREATE TABLE IF NOT EXISTS ${T('export_jobs')} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      requested_by uuid NOT NULL REFERENCES "core"."users"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      dashboard_code text NULL,
      metric_code text NULL,
      scope jsonb NOT NULL,
      filters jsonb NOT NULL DEFAULT '{}'::jsonb,
      risk_level text NOT NULL,
      mfa_step_up_id uuid NULL,
      status text NOT NULL DEFAULT 'QUEUED',
      row_count integer NULL,
      file_id uuid NULL,
      file_sha256 char(64) NULL,
      expires_at timestamptz NULL,
      download_count integer NOT NULL DEFAULT 0,
      masked_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
      error_code text NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT export_jobs_target_required CHECK (dashboard_code IS NOT NULL OR metric_code IS NOT NULL),
      CONSTRAINT export_jobs_risk_valid CHECK (risk_level IN ('LOW', 'HIGH')),
      CONSTRAINT export_jobs_high_requires_mfa CHECK (risk_level = 'LOW' OR mfa_step_up_id IS NOT NULL),
      CONSTRAINT export_jobs_status_valid CHECK (status IN ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED')),
      CONSTRAINT export_jobs_scope_object CHECK (jsonb_typeof(scope) = 'object' AND jsonb_typeof(filters) = 'object'),
      CONSTRAINT export_jobs_masked_array CHECK (jsonb_typeof(masked_fields) = 'array'),
      CONSTRAINT export_jobs_counts_nonneg CHECK (download_count >= 0 AND (row_count IS NULL OR row_count >= 0)),
      CONSTRAINT export_jobs_sha_format CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT export_jobs_ready_needs_file CHECK (status NOT IN ('READY') OR (file_sha256 IS NOT NULL AND expires_at IS NOT NULL AND row_count IS NOT NULL)),
      CONSTRAINT export_jobs_failed_needs_code CHECK (status <> 'FAILED' OR error_code IS NOT NULL)
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS export_jobs_requester_idx ON ${T('export_jobs')} (requested_by, created_at DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS export_jobs_expiry_idx ON ${T('export_jobs')} (expires_at) WHERE status = 'READY'`);
}

async function createGuards(q) {
  // Chave proibida (sql, formula, expression), sem diferenciar maiúscula, em qualquer profundidade.
  await q(`
    CREATE OR REPLACE FUNCTION ${SCHEMA}.jsonb_has_forbidden_keys(j jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $fn$
    DECLARE item record;
    BEGIN
      IF jsonb_typeof(j) = 'object' THEN
        FOR item IN SELECT key, value FROM jsonb_each(j) LOOP
          IF lower(item.key) IN ('sql', 'formula', 'expression') OR ${SCHEMA}.jsonb_has_forbidden_keys(item.value) THEN RETURN true; END IF;
        END LOOP;
      ELSIF jsonb_typeof(j) = 'array' THEN
        FOR item IN SELECT value FROM jsonb_array_elements(j) LOOP
          IF ${SCHEMA}.jsonb_has_forbidden_keys(item.value) THEN RETURN true; END IF;
        END LOOP;
      END IF;
      RETURN false;
    END
    $fn$
  `);

  // Painel: fora de DRAFT só o status muda (PUBLISHED -> RETIRED); nunca volta a DRAFT.
  await q(`
    CREATE OR REPLACE FUNCTION ${SCHEMA}.dashboard_definitions_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'DRAFT' THEN
          RAISE EXCEPTION 'Painel publicado não pode ser removido. Publique uma nova versão.' USING ERRCODE = 'ANA09';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.status <> 'DRAFT' THEN
        IF (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'updated_by'])
           OR NEW.status NOT IN (OLD.status, 'RETIRED') OR (OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED') THEN
          RAISE EXCEPTION 'Painel publicado não pode ser alterado. Publique uma nova versão.' USING ERRCODE = 'ANA09';
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$
  `);
  await q(`DROP TRIGGER IF EXISTS dashboard_definitions_guard ON ${T('dashboard_definitions')}`);
  await q(`CREATE TRIGGER dashboard_definitions_guard BEFORE UPDATE OR DELETE ON ${T('dashboard_definitions')} FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.dashboard_definitions_guard()`);

  // Widget: config sem fórmula/SQL (ANA08); escopo igual ao do painel; painel fora de DRAFT é imutável (ANA09).
  await q(`
    CREATE OR REPLACE FUNCTION ${SCHEMA}.dashboard_widgets_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE dash RECORD; target uuid;
    BEGIN
      target := CASE WHEN TG_OP = 'DELETE' THEN OLD.dashboard_id ELSE NEW.dashboard_id END;
      SELECT company_id, group_id, status INTO dash FROM ${T('dashboard_definitions')} WHERE id = target;
      IF TG_OP <> 'INSERT' AND (NOT FOUND OR dash.status <> 'DRAFT') THEN
        RAISE EXCEPTION 'Os widgets de um painel publicado não mudam. Crie uma nova versão do painel.' USING ERRCODE = 'ANA09';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      IF ${SCHEMA}.jsonb_has_forbidden_keys(NEW.config) THEN
        RAISE EXCEPTION 'Widget não pode conter fórmula ou SQL; use um indicador do registro.' USING ERRCODE = 'ANA08';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NOT FOUND OR dash.company_id IS DISTINCT FROM NEW.company_id OR dash.group_id IS DISTINCT FROM NEW.group_id THEN
          RAISE EXCEPTION 'Empresa não encontrada ou sem acesso.' USING ERRCODE = 'ANA05';
        END IF;
        IF dash.status <> 'DRAFT' THEN
          RAISE EXCEPTION 'Os widgets de um painel publicado não mudam. Crie uma nova versão do painel.' USING ERRCODE = 'ANA09';
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$
  `);
  await q(`DROP TRIGGER IF EXISTS dashboard_widgets_guard ON ${T('dashboard_widgets')}`);
  await q(`CREATE TRIGGER dashboard_widgets_guard BEFORE INSERT OR UPDATE OR DELETE ON ${T('dashboard_widgets')} FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.dashboard_widgets_guard()`);

  // Briefing gravado só pode virar SUPERSEDED (nada do conteúdo muda).
  await q(`
    CREATE OR REPLACE FUNCTION ${SCHEMA}.executive_briefs_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF (to_jsonb(NEW) - ARRAY['status', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at'])
         OR NEW.status <> OLD.status AND NEW.status <> 'SUPERSEDED' OR OLD.status = 'SUPERSEDED' AND NEW.status <> 'SUPERSEDED' THEN
        RAISE EXCEPTION 'Briefing gravado não pode ser alterado; gere um novo (o anterior vira SUPERSEDED).' USING ERRCODE = 'ANA10';
      END IF;
      RETURN NEW;
    END
    $fn$
  `);
  await q(`DROP TRIGGER IF EXISTS executive_briefs_guard ON ${T('executive_briefs')}`);
  await q(`CREATE TRIGGER executive_briefs_guard BEFORE UPDATE ON ${T('executive_briefs')} FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.executive_briefs_guard()`);

  // Export: escopo, filtros, alvo, solicitante e risco congelados no pedido (ANA07).
  await q(`
    CREATE OR REPLACE FUNCTION ${SCHEMA}.export_jobs_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF (to_jsonb(NEW) - ARRAY['status', 'row_count', 'file_id', 'file_sha256', 'expires_at', 'download_count', 'masked_fields', 'error_code', 'updated_at'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['status', 'row_count', 'file_id', 'file_sha256', 'expires_at', 'download_count', 'masked_fields', 'error_code', 'updated_at']) THEN
        RAISE EXCEPTION 'Os filtros da exportação são congelados no pedido.' USING ERRCODE = 'ANA07';
      END IF;
      RETURN NEW;
    END
    $fn$
  `);
  await q(`DROP TRIGGER IF EXISTS export_jobs_guard ON ${T('export_jobs')}`);
  await q(`CREATE TRIGGER export_jobs_guard BEFORE UPDATE ON ${T('export_jobs')} FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.export_jobs_guard()`);

  for (const table of ['dashboard_definitions', 'dashboard_widgets', 'executive_briefs', 'export_jobs']) {
    await q(`DROP TRIGGER IF EXISTS analytics_scope_guard ON ${T(table)}`);
    await q(`CREATE TRIGGER analytics_scope_guard BEFORE INSERT ON ${T(table)} FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.analytics_scope_guard()`);
  }
}

const TABLES = ['dashboard_definitions', 'dashboard_widgets', 'executive_briefs', 'export_jobs'];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[base]] = await q("SELECT to_regprocedure('analytics.analytics_scope_guard()') IS NOT NULL AS ok");
    if (!base.ok) throw new Error('Aplique antes a migration 20260101009600 (núcleo de métricas do BI).');
    await createDashboardTables(q);
    await createBriefAndExportTables(q);
    await createGuards(q);
    await applyRls(q, 'dashboard_definitions', READ_CATALOG);
    await applyRls(q, 'dashboard_widgets', READ_CATALOG);
    await applyRls(q, 'executive_briefs', READ_TENANT);
    // Pedido de exportação nasce na transação do usuário: sem a GUC do worker, mas só em nome de quem pede e QUEUED.
    await applyRls(q, 'export_jobs', READ_TENANT, `(${WRITER_ON} OR (requested_by = ${USER_GUC} AND status = 'QUEUED'))`);
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "${SCHEMA}" TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLES.map(T).join(', ')} TO nayara_runtime;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const table of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS ${T(table)}`);
    for (const fn of ['jsonb_has_forbidden_keys(jsonb)', 'dashboard_definitions_guard()', 'dashboard_widgets_guard()', 'executive_briefs_guard()', 'export_jobs_guard()']) {
      await q(`DROP FUNCTION IF EXISTS ${SCHEMA}.${fn}`);
    }
  },
};
