'use strict';

/**
 * M9-D401 — schema "marketing", parte 2: fila de publicações e resultados, automações (fluxo, versão, execução),
 * lista de supressão, links rastreáveis, eventos de atribuição e pedidos de avaliação.
 *
 * Mesma convenção da parte 1 (migration 750): id uuid, group_id/company_id NOT NULL, auditoria, RLS FORCE por grupo E
 * empresa (fail-closed), GRANT ao nayara_runtime só se o role existir, FKs compostas (id, company_id) entre tabelas do
 * schema, migration idempotente numa transação só. Duas garantias ficam no banco:
 *  - publication_results é append-only (UPDATE e DELETE recusados, MK002) e redige segredos do payload do provedor
 *    antes de gravar (marcador único [REDIGIDO]);
 *  - versão de automação que saiu de DRAFT é imutável (MK003); só o estado muda.
 * O down recusa se houver dado e só remove o schema se ele ficar sem nenhum objeto.
 */

const CHANNELS = ['WHATSAPP', 'EMAIL', 'SITE', 'INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'TIKTOK', 'PORTAL'];
const list = (arr) => arr.map((v) => `'${v}'`).join(', ');
const HASH_RE = "'^[0-9a-f]{64}$'";

const TABLES = [
  'publication_jobs', 'publication_results', 'automation_flows', 'automation_versions', 'automation_runs',
  'suppression_list', 'tracking_links', 'attribution_events', 'review_requests',
];
const DROP_ORDER = [
  'review_requests', 'attribution_events', 'tracking_links', 'suppression_list', 'automation_runs',
  'automation_versions', 'automation_flows', 'publication_results', 'publication_jobs',
];

const common = `
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,`;
const audit = `
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by uuid NULL,
  updated_by uuid NULL,
  deleted_at timestamptz NULL`;
const auditAppendOnly = `
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by uuid NULL`;

// Chaves cujo valor nunca é gravado em response_redacted_json.
const SECRET_KEY_RE = "(authorization|cookie|passw(or)?d|secret|api[_-]?key|private[_-]?key|credential|(^|[_-])token$|(access|refresh|id|auth|bearer|session|csrf|xsrf)[_-]?token)";

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });

      await q('CREATE SCHEMA IF NOT EXISTS marketing');

      // ---------- funções ----------
      await q(`CREATE OR REPLACE FUNCTION marketing.redact_secrets(j jsonb) RETURNS jsonb
        LANGUAGE plpgsql IMMUTABLE AS $fn$
        BEGIN
          IF j IS NULL THEN RETURN NULL; END IF;
          CASE jsonb_typeof(j)
            WHEN 'object' THEN
              RETURN COALESCE((SELECT jsonb_object_agg(k, CASE WHEN k ~* '${SECRET_KEY_RE}' THEN to_jsonb('[REDIGIDO]'::text) ELSE marketing.redact_secrets(v) END)
                                 FROM jsonb_each(j) AS t(k, v)), '{}'::jsonb);
            WHEN 'array' THEN
              RETURN COALESCE((SELECT jsonb_agg(marketing.redact_secrets(e) ORDER BY ord) FROM jsonb_array_elements(j) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb);
            WHEN 'string' THEN
              IF (j #>> '{}') ~* '^\\s*(bearer|basic)\\s+\\S+' THEN RETURN to_jsonb('[REDIGIDO]'::text); END IF;
              RETURN j;
            ELSE RETURN j;
          END CASE;
        END
        $fn$`);

      await q(`CREATE OR REPLACE FUNCTION marketing.actions_result_valid(j jsonb) RETURNS boolean
        LANGUAGE sql IMMUTABLE AS $fn$
          SELECT jsonb_typeof(j) = 'array' AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(j) AS t(e)
             WHERE jsonb_typeof(e) <> 'object'
                OR length(btrim(COALESCE(e->>'action_key', ''))) = 0
                OR COALESCE(e->>'status', '') NOT IN ('PENDING','SCHEDULED','OK','SKIPPED','FAILED','UNKNOWN'))
        $fn$`);

      await q(`CREATE OR REPLACE FUNCTION marketing.publication_results_guard() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF TG_OP = 'INSERT' THEN
            NEW.response_redacted_json := marketing.redact_secrets(NEW.response_redacted_json);
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'MKT_RESULT_APPEND_ONLY: o resultado de publicação não pode ser alterado.' USING ERRCODE = 'MK002';
        END
        $fn$`);

      await q(`CREATE OR REPLACE FUNCTION marketing.automation_versions_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF OLD.status <> 'DRAFT' AND (
               NEW.status = 'DRAFT'
            OR NEW.flow_id IS DISTINCT FROM OLD.flow_id
            OR NEW.version_no IS DISTINCT FROM OLD.version_no
            OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type
            OR NEW.trigger_config IS DISTINCT FROM OLD.trigger_config
            OR NEW.conditions IS DISTINCT FROM OLD.conditions
            OR NEW.actions IS DISTINCT FROM OLD.actions
            OR NEW.cooldown IS DISTINCT FROM OLD.cooldown
            OR NEW.frequency_cap IS DISTINCT FROM OLD.frequency_cap
            OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
            OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
            OR NEW.risk_level IS DISTINCT FROM OLD.risk_level
            OR NEW.content_hash IS DISTINCT FROM OLD.content_hash) THEN
            RAISE EXCEPTION 'MKT_AUTOMATION_VERSION_IMMUTABLE: a versão publicada é imutável; crie uma nova versão.' USING ERRCODE = 'MK003';
          END IF;
          RETURN NEW;
        END
        $fn$`);

      // ---------- publication_jobs ----------
      await q(`CREATE TABLE IF NOT EXISTS marketing.publication_jobs (${common}
        content_version_id uuid NOT NULL,
        channel varchar(16) NOT NULL,
        adapter_code varchar(80) NOT NULL,
        connection_id uuid NULL REFERENCES integration.connections(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        status varchar(12) NOT NULL DEFAULT 'PENDING',
        idempotency_key varchar(300) NOT NULL,
        scheduled_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NULL,
        external_post_id varchar(300) NULL,
        last_error_code varchar(120) NULL,${audit},
        CONSTRAINT mkt_publication_jobs_idempotency_uq UNIQUE (company_id, idempotency_key),
        CONSTRAINT mkt_publication_jobs_id_company_uq UNIQUE (id, company_id),
        CONSTRAINT mkt_publication_jobs_idempotency_format_chk CHECK (idempotency_key ~ '^pub:[0-9a-f-]{36}:[A-Z]+:.+$'),
        CONSTRAINT mkt_publication_jobs_channel_chk CHECK (channel IN (${list(CHANNELS)})),
        CONSTRAINT mkt_publication_jobs_adapter_chk CHECK (length(btrim(adapter_code)) > 0),
        CONSTRAINT mkt_publication_jobs_status_chk CHECK (status IN ('PENDING','RUNNING','PUBLISHED','FAILED','UNKNOWN','CANCELLED')),
        CONSTRAINT mkt_publication_jobs_attempts_chk CHECK (attempts >= 0),
        CONSTRAINT mkt_publication_jobs_content_version_fk FOREIGN KEY (content_version_id, company_id)
          REFERENCES marketing.content_versions (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_publication_jobs_company_status_idx ON marketing.publication_jobs (company_id, status) WHERE deleted_at IS NULL');
      await q('CREATE INDEX IF NOT EXISTS mkt_publication_jobs_due_idx ON marketing.publication_jobs (next_attempt_at) WHERE status IN (\'PENDING\',\'UNKNOWN\')');
      await q('CREATE INDEX IF NOT EXISTS mkt_publication_jobs_version_idx ON marketing.publication_jobs (content_version_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_publication_jobs_connection_idx ON marketing.publication_jobs (connection_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_publication_jobs_group_idx ON marketing.publication_jobs (group_id)');

      // ---------- publication_results (append-only) ----------
      await q(`CREATE TABLE IF NOT EXISTS marketing.publication_results (${common}
        job_id uuid NOT NULL,
        attempt_no integer NOT NULL,
        outcome varchar(24) NOT NULL,
        external_post_id varchar(300) NULL,
        external_url text NULL,
        provider_status varchar(120) NULL,
        metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        response_redacted_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,${auditAppendOnly},
        CONSTRAINT mkt_publication_results_attempt_no_chk CHECK (attempt_no >= 1),
        CONSTRAINT mkt_publication_results_outcome_chk CHECK (outcome IN ('SUCCESS','FAILURE','TIMEOUT','RECONCILED_FOUND','RECONCILED_NOT_FOUND')),
        CONSTRAINT mkt_publication_results_job_fk FOREIGN KEY (job_id, company_id)
          REFERENCES marketing.publication_jobs (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_publication_results_job_idx ON marketing.publication_results (company_id, job_id, attempt_no)');
      await q('CREATE INDEX IF NOT EXISTS mkt_publication_results_group_idx ON marketing.publication_results (group_id)');
      await q('DROP TRIGGER IF EXISTS publication_results_guard ON marketing.publication_results');
      await q(`CREATE TRIGGER publication_results_guard BEFORE INSERT OR UPDATE OR DELETE ON marketing.publication_results
        FOR EACH ROW EXECUTE FUNCTION marketing.publication_results_guard()`);

      // ---------- automation_flows ----------
      await q(`CREATE TABLE IF NOT EXISTS marketing.automation_flows (${common}
        code varchar(80) NOT NULL,
        name varchar(200) NOT NULL,
        owner_user_id uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        risk_level varchar(8) NOT NULL DEFAULT 'LOW',
        status varchar(8) NOT NULL DEFAULT 'ACTIVE',
        published_version_id uuid NULL,
        kill_switch_active boolean NOT NULL DEFAULT false,
        kill_switch_at timestamptz NULL,
        kill_switch_by uuid NULL,
        kill_switch_reason text NULL,${audit},
        CONSTRAINT mkt_automation_flows_company_code_uq UNIQUE (company_id, code),
        CONSTRAINT mkt_automation_flows_id_company_uq UNIQUE (id, company_id),
        CONSTRAINT mkt_automation_flows_code_chk CHECK (length(btrim(code)) > 0),
        CONSTRAINT mkt_automation_flows_name_chk CHECK (length(btrim(name)) > 0),
        CONSTRAINT mkt_automation_flows_risk_chk CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
        CONSTRAINT mkt_automation_flows_status_chk CHECK (status IN ('ACTIVE','PAUSED'))
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_automation_flows_company_status_idx ON marketing.automation_flows (company_id, status) WHERE deleted_at IS NULL');
      await q('CREATE INDEX IF NOT EXISTS mkt_automation_flows_owner_idx ON marketing.automation_flows (owner_user_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_automation_flows_group_idx ON marketing.automation_flows (group_id)');

      // ---------- automation_versions ----------
      await q(`CREATE TABLE IF NOT EXISTS marketing.automation_versions (${common}
        flow_id uuid NOT NULL,
        version_no integer NOT NULL,
        trigger_type varchar(8) NOT NULL,
        trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
        conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
        actions jsonb NOT NULL DEFAULT '[]'::jsonb,
        cooldown jsonb NOT NULL DEFAULT '{}'::jsonb,
        frequency_cap jsonb NOT NULL DEFAULT '{}'::jsonb,
        valid_from timestamptz NULL,
        valid_until timestamptz NULL,
        status varchar(12) NOT NULL DEFAULT 'DRAFT',
        risk_level varchar(8) NOT NULL DEFAULT 'LOW',
        content_hash char(64) NOT NULL,${audit},
        CONSTRAINT mkt_automation_versions_flow_version_uq UNIQUE (flow_id, version_no),
        CONSTRAINT mkt_automation_versions_id_company_uq UNIQUE (id, company_id),
        CONSTRAINT mkt_automation_versions_version_no_chk CHECK (version_no >= 1),
        CONSTRAINT mkt_automation_versions_trigger_type_chk CHECK (trigger_type IN ('EVENT','SCHEDULE')),
        CONSTRAINT mkt_automation_versions_actions_chk CHECK (jsonb_typeof(actions) = 'array'),
        CONSTRAINT mkt_automation_versions_status_chk CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED','PAUSED')),
        CONSTRAINT mkt_automation_versions_risk_chk CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
        CONSTRAINT mkt_automation_versions_validity_chk CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from),
        CONSTRAINT mkt_automation_versions_content_hash_chk CHECK (content_hash ~ ${HASH_RE}),
        CONSTRAINT mkt_automation_versions_flow_fk FOREIGN KEY (flow_id, company_id)
          REFERENCES marketing.automation_flows (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_automation_versions_company_status_idx ON marketing.automation_versions (company_id, status) WHERE deleted_at IS NULL');
      await q('CREATE INDEX IF NOT EXISTS mkt_automation_versions_group_idx ON marketing.automation_versions (group_id)');
      await q('DROP TRIGGER IF EXISTS automation_versions_immutable ON marketing.automation_versions');
      await q(`CREATE TRIGGER automation_versions_immutable BEFORE UPDATE ON marketing.automation_versions
        FOR EACH ROW EXECUTE FUNCTION marketing.automation_versions_immutable()`);

      await q(`DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_automation_flows_published_version_fk' AND conrelid = 'marketing.automation_flows'::regclass) THEN
            ALTER TABLE marketing.automation_flows ADD CONSTRAINT mkt_automation_flows_published_version_fk
              FOREIGN KEY (published_version_id, company_id) REFERENCES marketing.automation_versions (id, company_id)
              ON UPDATE CASCADE ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
          END IF;
        END $$`);

      // ---------- automation_runs ----------
      await q(`CREATE TABLE IF NOT EXISTS marketing.automation_runs (${common}
        automation_version_id uuid NOT NULL,
        trigger_event_id varchar(160) NULL,
        subject_type varchar(40) NULL,
        subject_id uuid NULL,
        correlation_id uuid NOT NULL,
        idempotency_key varchar(300) NOT NULL,
        status varchar(12) NOT NULL DEFAULT 'STARTED',
        blocked_reason varchar(200) NULL,
        policy_trace jsonb NOT NULL DEFAULT '[]'::jsonb,
        next_due_at timestamptz NULL,
        actions_result jsonb NOT NULL DEFAULT '[]'::jsonb,
        started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at timestamptz NULL,${audit},
        CONSTRAINT mkt_automation_runs_idempotency_uq UNIQUE (company_id, idempotency_key),
        CONSTRAINT mkt_automation_runs_status_chk CHECK (status IN ('STARTED','WAITING','COMPLETED','BLOCKED','FAILED')),
        CONSTRAINT mkt_automation_runs_waiting_due_chk CHECK (status <> 'WAITING' OR next_due_at IS NOT NULL),
        CONSTRAINT mkt_automation_runs_actions_result_chk CHECK (marketing.actions_result_valid(actions_result)),
        CONSTRAINT mkt_automation_runs_version_fk FOREIGN KEY (automation_version_id, company_id)
          REFERENCES marketing.automation_versions (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_automation_runs_company_status_idx ON marketing.automation_runs (company_id, status)');
      await q('CREATE INDEX IF NOT EXISTS mkt_automation_runs_waiting_due_idx ON marketing.automation_runs (next_due_at) WHERE status = \'WAITING\'');
      await q('CREATE INDEX IF NOT EXISTS mkt_automation_runs_version_idx ON marketing.automation_runs (automation_version_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_automation_runs_subject_idx ON marketing.automation_runs (company_id, subject_type, subject_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_automation_runs_group_idx ON marketing.automation_runs (group_id)');

      // ---------- suppression_list ----------
      await q(`CREATE TABLE IF NOT EXISTS marketing.suppression_list (${common}
        person_id uuid NULL REFERENCES people.persons(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        address_hash char(64) NOT NULL,
        channel varchar(16) NOT NULL,
        purpose varchar(40) NULL,
        reason varchar(12) NOT NULL,
        source varchar(120) NOT NULL,
        active boolean NOT NULL DEFAULT true,
        expires_at timestamptz NULL,
        lifted_by uuid NULL,
        lifted_at timestamptz NULL,${audit},
        CONSTRAINT mkt_suppression_list_address_hash_chk CHECK (address_hash ~ ${HASH_RE}),
        CONSTRAINT mkt_suppression_list_channel_chk CHECK (channel IN (${list(CHANNELS)})),
        CONSTRAINT mkt_suppression_list_purpose_chk CHECK (purpose IS NULL OR length(btrim(purpose)) > 0),
        CONSTRAINT mkt_suppression_list_reason_chk CHECK (reason IN ('OPT_OUT','BOUNCE','COMPLAINT','LEGAL','MANUAL')),
        CONSTRAINT mkt_suppression_list_source_chk CHECK (length(btrim(source)) > 0)
      )`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS mkt_suppression_active_uq
        ON marketing.suppression_list (company_id, address_hash, channel, (COALESCE(purpose, '*'))) WHERE active`);
      await q('CREATE INDEX IF NOT EXISTS mkt_suppression_list_company_status_idx ON marketing.suppression_list (company_id, active)');
      await q('CREATE INDEX IF NOT EXISTS mkt_suppression_list_person_idx ON marketing.suppression_list (company_id, person_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_suppression_list_group_idx ON marketing.suppression_list (group_id)');

      // ---------- tracking_links ----------
      await q(`CREATE TABLE IF NOT EXISTS marketing.tracking_links (${common}
        campaign_id uuid NULL,
        content_item_id uuid NULL,
        short_code varchar(64) NOT NULL,
        target_url text NOT NULL,
        utm_source varchar(200) NULL,
        utm_medium varchar(200) NULL,
        utm_campaign varchar(200) NULL,
        utm_content varchar(200) NULL,
        utm_term varchar(200) NULL,
        channel varchar(16) NOT NULL,
        signature varchar(128) NOT NULL,
        expires_at timestamptz NULL,
        status varchar(8) NOT NULL DEFAULT 'ACTIVE',${audit},
        CONSTRAINT mkt_tracking_links_short_code_uq UNIQUE (short_code),
        CONSTRAINT mkt_tracking_links_short_code_chk CHECK (short_code ~ '^[A-Za-z0-9_-]{4,64}$'),
        CONSTRAINT mkt_tracking_links_target_url_chk CHECK (target_url ~* '^https?://'),
        CONSTRAINT mkt_tracking_links_channel_chk CHECK (channel IN (${list(CHANNELS)})),
        CONSTRAINT mkt_tracking_links_signature_chk CHECK (length(btrim(signature)) > 0),
        CONSTRAINT mkt_tracking_links_status_chk CHECK (status IN ('ACTIVE','EXPIRED','REVOKED')),
        CONSTRAINT mkt_tracking_links_id_company_uq UNIQUE (id, company_id),
        CONSTRAINT mkt_tracking_links_campaign_fk FOREIGN KEY (campaign_id, company_id)
          REFERENCES marketing.campaigns (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT mkt_tracking_links_content_fk FOREIGN KEY (content_item_id, company_id)
          REFERENCES marketing.content_items (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_tracking_links_company_status_idx ON marketing.tracking_links (company_id, status) WHERE deleted_at IS NULL');
      await q('CREATE INDEX IF NOT EXISTS mkt_tracking_links_campaign_idx ON marketing.tracking_links (campaign_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_tracking_links_content_idx ON marketing.tracking_links (content_item_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_tracking_links_group_idx ON marketing.tracking_links (group_id)');

      // ---------- attribution_events ----------
      await q(`CREATE TABLE IF NOT EXISTS marketing.attribution_events (${common}
        person_id uuid NULL REFERENCES people.persons(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        opportunity_id uuid NULL REFERENCES crm.opportunities(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        campaign_id uuid NULL,
        tracking_link_id uuid NULL,
        event_type varchar(16) NOT NULL,
        touch_roles text[] NOT NULL DEFAULT '{}',
        evidence_json jsonb NOT NULL,
        valid boolean NOT NULL DEFAULT true,
        occurred_at timestamptz NOT NULL,${audit},
        CONSTRAINT mkt_attribution_events_event_type_chk CHECK (event_type IN ('CLICK','LEAD_CREATED','VISIT','PROPOSAL','SALE')),
        CONSTRAINT mkt_attribution_events_person_chk CHECK (event_type = 'CLICK' OR person_id IS NOT NULL),
        CONSTRAINT mkt_attribution_events_touch_roles_chk CHECK (touch_roles <@ ARRAY['FIRST','LAST']::text[]),
        CONSTRAINT mkt_attribution_events_campaign_fk FOREIGN KEY (campaign_id, company_id)
          REFERENCES marketing.campaigns (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT mkt_attribution_events_link_fk FOREIGN KEY (tracking_link_id, company_id)
          REFERENCES marketing.tracking_links (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_attribution_events_company_type_idx ON marketing.attribution_events (company_id, event_type, occurred_at)');
      await q('CREATE INDEX IF NOT EXISTS mkt_attribution_events_person_idx ON marketing.attribution_events (company_id, person_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_attribution_events_opportunity_idx ON marketing.attribution_events (opportunity_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_attribution_events_campaign_idx ON marketing.attribution_events (campaign_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_attribution_events_link_idx ON marketing.attribution_events (tracking_link_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_attribution_events_group_idx ON marketing.attribution_events (group_id)');

      // ---------- review_requests ----------
      await q(`CREATE TABLE IF NOT EXISTS marketing.review_requests (${common}
        person_id uuid NOT NULL REFERENCES people.persons(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        source_entity_type varchar(80) NOT NULL,
        source_entity_id uuid NOT NULL,
        satisfaction_score integer NULL,
        platform varchar(40) NULL,
        public_rating integer NULL,
        completed_at timestamptz NULL,
        status varchar(16) NOT NULL DEFAULT 'PENDING',
        feedback_case_id uuid NULL,
        channel varchar(16) NOT NULL,
        sent_at timestamptz NULL,${audit},
        CONSTRAINT mkt_review_requests_satisfaction_chk CHECK (satisfaction_score IS NULL OR satisfaction_score BETWEEN 1 AND 5),
        CONSTRAINT mkt_review_requests_public_rating_chk CHECK (public_rating IS NULL OR public_rating BETWEEN 1 AND 5),
        CONSTRAINT mkt_review_requests_status_chk CHECK (status IN ('PENDING','BLOCKED_NEGATIVE','SENT','DELIVERED','COMPLETED','FAILED','SUPPRESSED')),
        CONSTRAINT mkt_review_requests_channel_chk CHECK (channel IN (${list(CHANNELS)})),
        CONSTRAINT mkt_review_requests_source_chk CHECK (length(btrim(source_entity_type)) > 0)
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_review_requests_company_status_idx ON marketing.review_requests (company_id, status) WHERE deleted_at IS NULL');
      await q('CREATE INDEX IF NOT EXISTS mkt_review_requests_person_idx ON marketing.review_requests (company_id, person_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_review_requests_source_idx ON marketing.review_requests (company_id, source_entity_type, source_entity_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_review_requests_group_idx ON marketing.review_requests (group_id)');

      // ---------- RLS FORCE por grupo e empresa, fail-closed ----------
      for (const t of TABLES) {
        await q(`ALTER TABLE marketing.${t} ENABLE ROW LEVEL SECURITY`);
        await q(`ALTER TABLE marketing.${t} FORCE ROW LEVEL SECURITY`);
        await q(`DROP POLICY IF EXISTS tenant_isolation ON marketing.${t}`);
        await q(`CREATE POLICY tenant_isolation ON marketing.${t}
          USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
                 AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
      }

      const [[{ exists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists", { transaction });
      if (exists) {
        await q('GRANT USAGE ON SCHEMA marketing TO nayara_runtime');
        // Sem DELETE: exclusão lógica (deleted_at); publication_results é append-only (o gatilho recusa UPDATE/DELETE).
        await q(`GRANT SELECT, INSERT, UPDATE ON ${TABLES.map((t) => `marketing.${t}`).join(', ')} TO nayara_runtime`);
      }
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      for (const t of DROP_ORDER) {
        const [[{ reg }]] = await sequelize.query(`SELECT to_regclass('marketing.${t}') AS reg`, { transaction });
        if (!reg) continue;
        const [[{ n }]] = await sequelize.query(`SELECT count(*)::int AS n FROM marketing.${t}`, { transaction });
        if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: marketing.${t} não está vazia (${n} linhas); o down não apaga dados.`);
      }
      await q('ALTER TABLE IF EXISTS marketing.automation_flows DROP CONSTRAINT IF EXISTS mkt_automation_flows_published_version_fk');
      for (const t of DROP_ORDER) await q(`DROP TABLE IF EXISTS marketing.${t}`);
      await q('DROP FUNCTION IF EXISTS marketing.publication_results_guard()');
      await q('DROP FUNCTION IF EXISTS marketing.automation_versions_immutable()');
      await q('DROP FUNCTION IF EXISTS marketing.actions_result_valid(jsonb)');
      await q('DROP FUNCTION IF EXISTS marketing.redact_secrets(jsonb)');
      const [[{ restantes }]] = await sequelize.query(
        `SELECT count(*)::int AS restantes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'marketing' AND c.relkind IN ('r','v','m','S','f','p')`, { transaction });
      if (restantes === 0) await q('DROP SCHEMA IF EXISTS marketing');
    });
  },
};
