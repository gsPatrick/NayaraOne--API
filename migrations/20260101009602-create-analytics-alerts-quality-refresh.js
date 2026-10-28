'use strict';

/**
 * Marco 9, demanda M9-D602 (Caderno "Dashboards + BI + Centro de Comando", §3 Entidades e §16 Alertas):
 * analytics.alert_definitions, alert_instances, read_model_refreshes e data_quality_checks.
 *
 * - alert_definitions: regra de alerta. Condição EXCLUSIVA (limite simples OU regra publicada do Motor de
 *   Regras), owner obrigatório (BI-011) e nenhuma coluna/chave de pagamento (gatilho ANA12). Regra do Motor
 *   precisa ter versão PUBLISHED (gatilho ANA13).
 * - alert_instances: OPEN, ACKNOWLEDGED, RESOLVED. Índice único parcial (empresa, fingerprint) enquanto ativa.
 *   Reconhecer (OPEN -> ACKNOWLEDGED) é a única escrita sem a GUC do worker (serviço da M9-D703, na transação
 *   do usuário); RESOLVED é final (gatilho ANA11).
 * - metric_snapshot_id e task_id são uuid sem FK: o down da 9600 apaga metric_snapshots, e a tarefa é da M9-D692;
 *   a existência do snapshot é conferida no store.
 * - read_model_refreshes: diário de cada atualização dos read models. data_quality_checks: uma linha por check.
 *
 * Reaproveita analytics.analytics_scope_guard() da M9-D600. RLS ENABLE + FORCE, 4 políticas por tabela; escrita
 * com app.analytics_writer = 'on'. SQL puro e idempotente. Faixa de migrations do BI: 9600 a 9609.
 */

const SCHEMA = 'analytics';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const USER_GUC = "NULLIF(current_setting('app.user_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_CATALOG = `((company_id IS NULL AND group_id IS NULL) OR company_id = ${COMPANY_GUC} OR (company_id IS NULL AND group_id = ${GROUP_GUC}))`;
const READ_TENANT = `(company_id = ${COMPANY_GUC} OR (company_id IS NULL AND group_id = ${GROUP_GUC}))`;
const TABLES = ['alert_definitions', 'alert_instances', 'read_model_refreshes', 'data_quality_checks'];
const FUNCTIONS = ['jsonb_has_payment_keys(jsonb)', 'alert_definitions_guard()', 'alert_instances_guard()'];
const SEVERITIES = "'INFO', 'WARNING', 'CRITICAL'";
const ZERO = "'00000000-0000-0000-0000-000000000000'::uuid";

const T = (name) => `"${SCHEMA}"."${name}"`;

async function applyRls(q, table, readExpr, { updateUsing = WRITER_ON, updateCheck = WRITER_ON } = {}) {
  await q(`ALTER TABLE ${T(table)} ENABLE ROW LEVEL SECURITY`);
  await q(`ALTER TABLE ${T(table)} FORCE ROW LEVEL SECURITY`);
  for (const name of ['analytics_select', 'analytics_insert', 'analytics_update', 'analytics_delete']) {
    await q(`DROP POLICY IF EXISTS ${name} ON ${T(table)}`);
  }
  await q(`CREATE POLICY analytics_select ON ${T(table)} FOR SELECT USING (${readExpr})`);
  await q(`CREATE POLICY analytics_insert ON ${T(table)} FOR INSERT WITH CHECK (${WRITER_ON} AND ${readExpr})`);
  await q(`CREATE POLICY analytics_update ON ${T(table)} FOR UPDATE USING (${updateUsing} AND ${readExpr}) WITH CHECK (${updateCheck} AND ${readExpr})`);
  await q(`CREATE POLICY analytics_delete ON ${T(table)} FOR DELETE USING (${WRITER_ON} AND ${readExpr})`);
}

async function createAlertDefinitions(q) {
  await q(`
    CREATE TABLE IF NOT EXISTS ${T('alert_definitions')} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      group_id uuid NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      alert_code text NOT NULL,
      metric_code text NOT NULL,
      metric_version_pin integer NULL,
      condition_type text NOT NULL,
      threshold jsonb NULL,
      rule_id uuid NULL REFERENCES "core"."rules"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      severity text NOT NULL,
      owner_user_id uuid NULL REFERENCES "core"."users"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      owner_role text NULL,
      cooldown_minutes integer NULL,
      auto_resolve_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
      scope jsonb NOT NULL DEFAULT '{}'::jsonb,
      create_task boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'DRAFT',
      version integer NOT NULL DEFAULT 1,
      published_at timestamptz NULL,
      created_by uuid NULL,
      updated_by uuid NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT alert_definitions_code_format CHECK (alert_code ~ '^[a-z][a-z0-9_]*$'),
      CONSTRAINT alert_definitions_metric_code_format CHECK (metric_code ~ '^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$'),
      CONSTRAINT alert_definitions_pin_positive CHECK (metric_version_pin IS NULL OR metric_version_pin >= 1),
      CONSTRAINT alert_definitions_condition_type_valid CHECK (condition_type IN ('THRESHOLD', 'RULE_ENGINE')),
      CONSTRAINT alert_definitions_condition_valid CHECK (
        (condition_type = 'THRESHOLD' AND threshold IS NOT NULL AND rule_id IS NULL)
        OR (condition_type = 'RULE_ENGINE' AND rule_id IS NOT NULL AND threshold IS NULL)
      ),
      CONSTRAINT alert_definitions_threshold_shape CHECK (
        threshold IS NULL OR (
          jsonb_typeof(threshold) = 'object'
          AND COALESCE(threshold->>'operator' IN ('LT', 'LTE', 'GT', 'GTE', 'EQ', 'NEQ'), false)
          AND COALESCE(jsonb_typeof(threshold->'value') = 'number', false)
        )
      ),
      CONSTRAINT alert_definitions_severity_valid CHECK (severity IN (${SEVERITIES})),
      CONSTRAINT alert_definitions_owner_required CHECK (
        owner_user_id IS NOT NULL OR (owner_role IS NOT NULL AND length(btrim(owner_role)) > 0)
      ),
      CONSTRAINT alert_definitions_cooldown_nonneg CHECK (cooldown_minutes IS NULL OR cooldown_minutes >= 0),
      CONSTRAINT alert_definitions_auto_resolve_shape CHECK (
        jsonb_typeof(auto_resolve_policy) = 'object' AND (
          NOT (auto_resolve_policy ? 'consecutiveOkEvaluations')
          OR (jsonb_typeof(auto_resolve_policy->'consecutiveOkEvaluations') = 'number'
              AND (auto_resolve_policy->>'consecutiveOkEvaluations')::numeric >= 1
              AND (auto_resolve_policy->>'consecutiveOkEvaluations')::numeric = trunc((auto_resolve_policy->>'consecutiveOkEvaluations')::numeric))
        )
      ),
      CONSTRAINT alert_definitions_scope_object CHECK (jsonb_typeof(scope) = 'object'),
      CONSTRAINT alert_definitions_status_valid CHECK (status IN ('DRAFT', 'PUBLISHED', 'DISABLED')),
      CONSTRAINT alert_definitions_version_positive CHECK (version >= 1)
    )
  `);
  await q(`
    CREATE UNIQUE INDEX IF NOT EXISTS alert_definitions_code_version_uq ON ${T('alert_definitions')}
      (COALESCE(company_id, ${ZERO}), COALESCE(group_id, ${ZERO}), alert_code, version)
  `);
  await q(`
    CREATE UNIQUE INDEX IF NOT EXISTS alert_definitions_one_published_uq ON ${T('alert_definitions')}
      (COALESCE(company_id, ${ZERO}), COALESCE(group_id, ${ZERO}), alert_code) WHERE status = 'PUBLISHED'
  `);
  await q(`CREATE INDEX IF NOT EXISTS alert_definitions_metric_idx ON ${T('alert_definitions')} (metric_code) WHERE status = 'PUBLISHED'`);
}

async function createAlertInstances(q) {
  await q(`
    CREATE TABLE IF NOT EXISTS ${T('alert_instances')} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alert_definition_id uuid NOT NULL REFERENCES ${T('alert_definitions')}(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      fingerprint char(64) NOT NULL,
      status text NOT NULL DEFAULT 'OPEN',
      severity text NOT NULL,
      opened_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      acknowledged_at timestamptz NULL,
      acknowledged_by uuid NULL REFERENCES "core"."users"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      resolved_at timestamptz NULL,
      resolved_reason text NULL,
      last_evaluated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_value numeric NULL,
      metric_snapshot_id uuid NULL,
      task_id uuid NULL,
      occurrence_count integer NOT NULL DEFAULT 1,
      cooldown_until timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT alert_instances_fingerprint_format CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT alert_instances_status_valid CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
      CONSTRAINT alert_instances_severity_valid CHECK (severity IN (${SEVERITIES})),
      CONSTRAINT alert_instances_ack_complete CHECK (status <> 'ACKNOWLEDGED' OR (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)),
      CONSTRAINT alert_instances_resolved_complete CHECK (status <> 'RESOLVED' OR (resolved_at IS NOT NULL AND resolved_reason IS NOT NULL)),
      CONSTRAINT alert_instances_reason_valid CHECK (resolved_reason IS NULL OR resolved_reason IN ('CONDITION_NORMALIZED')),
      CONSTRAINT alert_instances_occurrence_positive CHECK (occurrence_count >= 1)
    )
  `);
  // Trava final contra duas avaliações simultâneas: um só alerta ativo por (empresa, fingerprint).
  await q(`
    CREATE UNIQUE INDEX IF NOT EXISTS alert_instances_active_fingerprint_uq ON ${T('alert_instances')} (company_id, fingerprint)
      WHERE status IN ('OPEN', 'ACKNOWLEDGED')
  `);
  await q(`CREATE INDEX IF NOT EXISTS alert_instances_definition_idx ON ${T('alert_instances')} (alert_definition_id, status)`);
  await q(`CREATE INDEX IF NOT EXISTS alert_instances_company_status_idx ON ${T('alert_instances')} (company_id, status, opened_at DESC)`);
}

async function createRefreshAndChecks(q) {
  await q(`
    CREATE TABLE IF NOT EXISTS ${T('read_model_refreshes')} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      read_model text NOT NULL,
      "trigger" text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at timestamptz NULL,
      status text NOT NULL DEFAULT 'RUNNING',
      source_snapshot_at timestamptz NULL,
      rows_upserted integer NOT NULL DEFAULT 0,
      last_source_event_id text NULL,
      version integer NOT NULL DEFAULT 1,
      error_code text NULL,
      error_message text NULL,
      duration_ms integer NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT read_model_refreshes_model_format CHECK (read_model ~ '^[a-z][a-z0-9_]*$'),
      CONSTRAINT read_model_refreshes_trigger_valid CHECK ("trigger" IN ('EVENT', 'SCHEDULE', 'REBUILD')),
      CONSTRAINT read_model_refreshes_status_valid CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'DEGRADED')),
      CONSTRAINT read_model_refreshes_finished_complete CHECK (status = 'RUNNING' OR (finished_at IS NOT NULL AND duration_ms IS NOT NULL)),
      CONSTRAINT read_model_refreshes_failed_needs_code CHECK (status <> 'FAILED' OR error_code IS NOT NULL),
      CONSTRAINT read_model_refreshes_finish_order CHECK (finished_at IS NULL OR finished_at >= started_at),
      CONSTRAINT read_model_refreshes_counts_nonneg CHECK (rows_upserted >= 0 AND (duration_ms IS NULL OR duration_ms >= 0) AND version >= 1)
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS read_model_refreshes_lookup_idx ON ${T('read_model_refreshes')} (company_id, read_model, started_at DESC)`);
  await q(`
    CREATE TABLE IF NOT EXISTS ${T('data_quality_checks')} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      check_code text NOT NULL,
      read_model text NOT NULL,
      check_type text NOT NULL,
      status text NOT NULL,
      expected jsonb NOT NULL DEFAULT '{}'::jsonb,
      observed jsonb NOT NULL DEFAULT '{}'::jsonb,
      severity text NOT NULL,
      affected_metric_codes text[] NOT NULL DEFAULT '{}',
      executed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      refresh_id uuid NULL REFERENCES ${T('read_model_refreshes')}(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT data_quality_checks_code_format CHECK (check_code ~ '^[a-z][a-z0-9_]*$' AND read_model ~ '^[a-z][a-z0-9_]*$'),
      CONSTRAINT data_quality_checks_type_valid CHECK (check_type IN ('COMPLETENESS', 'DUPLICATION', 'FRESHNESS', 'RECONCILIATION', 'CONSISTENCY', 'ROW_COUNT_RANGE', 'INVARIANT')),
      CONSTRAINT data_quality_checks_status_valid CHECK (status IN ('PASSED', 'FAILED', 'ERROR')),
      CONSTRAINT data_quality_checks_severity_valid CHECK (severity IN (${SEVERITIES})),
      CONSTRAINT data_quality_checks_payload_object CHECK (jsonb_typeof(expected) = 'object' AND jsonb_typeof(observed) = 'object')
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS data_quality_checks_refresh_idx ON ${T('data_quality_checks')} (refresh_id)`);
  await q(`CREATE INDEX IF NOT EXISTS data_quality_checks_lookup_idx ON ${T('data_quality_checks')} (company_id, read_model, executed_at DESC)`);
}

async function createGuards(q) {
  // Chave que indica ação de pagamento, em qualquer profundidade (nunca pagamento automático por alerta).
  await q(`
    CREATE OR REPLACE FUNCTION ${SCHEMA}.jsonb_has_payment_keys(j jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $fn$
    DECLARE item record;
    BEGIN
      IF jsonb_typeof(j) = 'object' THEN
        FOR item IN SELECT key, value FROM jsonb_each(j) LOOP
          IF item.key ~* '(pagament|payment|payout|boleto)'
             OR item.key ~* '^(pay|pagar|pix|transfer|transferencia)$'
             OR item.key ~ '^(pay|pagar|pix|transfer|transferencia)([A-Z_-])'
             OR ${SCHEMA}.jsonb_has_payment_keys(item.value) THEN RETURN true; END IF;
        END LOOP;
      ELSIF jsonb_typeof(j) = 'array' THEN
        FOR item IN SELECT value FROM jsonb_array_elements(j) LOOP
          IF ${SCHEMA}.jsonb_has_payment_keys(item.value) THEN RETURN true; END IF;
        END LOOP;
      END IF;
      RETURN false;
    END
    $fn$
  `);
  // ANA12 = ação de pagamento; ANA13 = regra do Motor sem versão publicada.
  await q(`
    CREATE OR REPLACE FUNCTION ${SCHEMA}.alert_definitions_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF ${SCHEMA}.jsonb_has_payment_keys(NEW.scope) OR ${SCHEMA}.jsonb_has_payment_keys(NEW.auto_resolve_policy)
         OR ${SCHEMA}.jsonb_has_payment_keys(COALESCE(NEW.threshold, '{}'::jsonb)) THEN
        RAISE EXCEPTION 'Alerta não pode disparar pagamento.' USING ERRCODE = 'ANA12';
      END IF;
      IF NEW.condition_type = 'RULE_ENGINE' AND NEW.rule_id IS NOT NULL
         AND (TG_OP = 'INSERT' OR OLD.rule_id IS DISTINCT FROM NEW.rule_id OR (NEW.status = 'PUBLISHED' AND OLD.status <> 'PUBLISHED')) THEN
        IF NOT EXISTS (
          SELECT 1 FROM "core"."rules" r JOIN "core"."rule_versions" v ON v.rule_id = r.id AND v.status = 'PUBLISHED'
           WHERE r.id = NEW.rule_id AND r.deleted_at IS NULL
             AND (NEW.group_id IS NULL OR r.group_id = NEW.group_id) AND (NEW.company_id IS NULL OR r.company_id = NEW.company_id)
        ) THEN
          RAISE EXCEPTION 'A regra escolhida não está publicada.' USING ERRCODE = 'ANA13';
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$
  `);
  await q(`DROP TRIGGER IF EXISTS alert_definitions_guard ON ${T('alert_definitions')}`);
  await q(`CREATE TRIGGER alert_definitions_guard BEFORE INSERT OR UPDATE ON ${T('alert_definitions')} FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.alert_definitions_guard()`);

  // ANA11 = transição ou campo proibido na instância. Fora do worker só vale OPEN -> ACKNOWLEDGED pelo próprio usuário.
  await q(`
    CREATE OR REPLACE FUNCTION ${SCHEMA}.alert_instances_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE
      writer boolean := COALESCE(current_setting('app.analytics_writer', true), '') = 'on';
      mutable text[] := ARRAY['status', 'severity', 'acknowledged_at', 'acknowledged_by', 'resolved_at', 'resolved_reason', 'last_evaluated_at',
                              'last_value', 'metric_snapshot_id', 'task_id', 'occurrence_count', 'cooldown_until', 'updated_at'];
      ack text[] := ARRAY['status', 'acknowledged_at', 'acknowledged_by', 'updated_at'];
    BEGIN
      IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
        RAISE EXCEPTION 'A identidade do alerta (definição, empresa, fingerprint) não muda.' USING ERRCODE = 'ANA11';
      END IF;
      IF OLD.status = 'RESOLVED' THEN
        RAISE EXCEPTION 'Alerta resolvido não pode ser alterado; um novo disparo abre outro alerta.' USING ERRCODE = 'ANA11';
      END IF;
      IF NEW.status <> OLD.status AND NOT (OLD.status = 'OPEN' AND NEW.status IN ('ACKNOWLEDGED', 'RESOLVED')
                                           OR OLD.status = 'ACKNOWLEDGED' AND NEW.status = 'RESOLVED') THEN
        RAISE EXCEPTION 'Transição de estado de alerta inválida.' USING ERRCODE = 'ANA11';
      END IF;
      IF NOT writer THEN
        IF NOT (OLD.status = 'OPEN' AND NEW.status = 'ACKNOWLEDGED' AND NEW.acknowledged_by IS NOT DISTINCT FROM ${USER_GUC}
                AND (to_jsonb(NEW) - ack) IS NOT DISTINCT FROM (to_jsonb(OLD) - ack)) THEN
          RAISE EXCEPTION 'Sem o worker de BI, só é permitido reconhecer um alerta aberto, em nome de quem reconhece.' USING ERRCODE = 'ANA11';
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$
  `);
  await q(`DROP TRIGGER IF EXISTS alert_instances_guard ON ${T('alert_instances')}`);
  await q(`CREATE TRIGGER alert_instances_guard BEFORE UPDATE ON ${T('alert_instances')} FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.alert_instances_guard()`);

  for (const table of TABLES) {
    await q(`DROP TRIGGER IF EXISTS analytics_scope_guard ON ${T(table)}`);
    await q(`CREATE TRIGGER analytics_scope_guard BEFORE INSERT ON ${T(table)} FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.analytics_scope_guard()`);
  }
}

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[base]] = await q("SELECT to_regprocedure('analytics.analytics_scope_guard()') IS NOT NULL AS ok");
    if (!base.ok) throw new Error('Aplique antes a migration 20260101009600 (núcleo de métricas do BI).');
    await createAlertDefinitions(q);
    await createAlertInstances(q);
    await createRefreshAndChecks(q);
    await createGuards(q);
    await applyRls(q, 'alert_definitions', READ_CATALOG);
    // Reconhecer é a única escrita do usuário: OPEN -> ACKNOWLEDGED em nome dele (o gatilho confere o resto).
    await applyRls(q, 'alert_instances', READ_TENANT, {
      updateUsing: `(${WRITER_ON} OR status = 'OPEN')`,
      updateCheck: `(${WRITER_ON} OR (status = 'ACKNOWLEDGED' AND acknowledged_by = ${USER_GUC}))`,
    });
    await applyRls(q, 'read_model_refreshes', READ_TENANT);
    await applyRls(q, 'data_quality_checks', READ_TENANT);
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
    for (const table of ['data_quality_checks', 'read_model_refreshes', 'alert_instances', 'alert_definitions']) {
      await q(`DROP TABLE IF EXISTS ${T(table)}`);
    }
    for (const fn of FUNCTIONS) await q(`DROP FUNCTION IF EXISTS ${SCHEMA}.${fn}`);
  },
};
