'use strict';

/**
 * M9-D400 — schema "marketing", parte 1: campanhas, públicos, etapas, conteúdos, versões e templates.
 *
 * Seis tabelas, todas com id uuid, group_id/company_id NOT NULL, auditoria (created_by/updated_by), exclusão lógica
 * (deleted_at) e RLS FORCE por grupo E empresa (fail-closed: sem SET LOCAL app.group_id/app.company_id a política não
 * enxerga linha alguma e também recusa INSERT). As tabelas filhas apontam para o pai por FK composta (id, company_id),
 * de modo que uma audiência, etapa ou versão nunca referencia campanha, template ou conteúdo de OUTRA empresa.
 * As outras nove tabelas do schema nascem na M9-D401.
 *
 * Imutabilidade: o trigger de content_versions recusa UPDATE do corpo, dos fatos congelados, dos hashes, do template e
 * da identidade da versão (erro MK001, MKT_CONTENT_VERSION_IMMUTABLE); só checks_json e os campos de aprovação mudam.
 *
 * Idempotente (IF NOT EXISTS e guardas), numa transação só. O down recusa se houver dado e só remove o schema se ele
 * ficar sem nenhum objeto (as tabelas da M9-D401 impedem a remoção do schema).
 */

const CHANNELS = ['WHATSAPP', 'EMAIL', 'SITE', 'INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'TIKTOK', 'PORTAL'];
const CONTENT_TYPES = [
  'NEW_PROPERTY', 'PRICE_REDUCTION', 'SOLD_RENTED', 'NAYARA_CONSTRUCTION', 'INSTITUTIONAL', 'EDUCATIONAL_BLOG',
  'POST_SALE', 'BIRTHDAY_RELATIONSHIP', 'SEGMENTED_CAMPAIGN', 'VIDEO_REEL',
];
const CONTENT_STATUS = [
  'DRAFT', 'FACT_CHECK_FAILED', 'FACT_CHECKED', 'BRANDED', 'COMPLIANCE_CHECKED', 'PENDING_APPROVAL', 'APPROVED',
  'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'ARCHIVED',
];
const list = (arr) => arr.map((v) => `'${v}'`).join(', ');
const HASH_RE = "'^[0-9a-f]{64}$'";

const TABLES = ['campaigns', 'templates', 'content_items', 'content_versions', 'campaign_audiences', 'campaign_steps'];

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

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });

      await q('CREATE SCHEMA IF NOT EXISTS marketing');

      await q(`CREATE TABLE IF NOT EXISTS marketing.campaigns (${common}
        code varchar(60) NOT NULL,
        name varchar(200) NOT NULL,
        objective text NOT NULL,
        objective_metric varchar(16) NOT NULL,
        target_value numeric(14,2) NOT NULL,
        budget_amount numeric(14,2) NOT NULL,
        budget_justification text NULL,
        cost_actual numeric(14,2) NOT NULL DEFAULT 0,
        channels text[] NOT NULL DEFAULT '{}',
        status varchar(12) NOT NULL DEFAULT 'DRAFT',
        result_value numeric(14,2) NULL,
        starts_at timestamptz NULL,
        ends_at timestamptz NULL,
        owner_user_id uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        kill_switch_active boolean NOT NULL DEFAULT false,
        kill_switch_at timestamptz NULL,
        kill_switch_by uuid NULL,
        kill_switch_reason text NULL,${audit},
        CONSTRAINT mkt_campaigns_company_code_uq UNIQUE (company_id, code),
        CONSTRAINT mkt_campaigns_id_company_uq UNIQUE (id, company_id),
        CONSTRAINT mkt_campaigns_code_chk CHECK (length(btrim(code)) > 0),
        CONSTRAINT mkt_campaigns_name_chk CHECK (length(btrim(name)) > 0),
        CONSTRAINT mkt_campaigns_objective_chk CHECK (char_length(btrim(objective)) >= 10),
        CONSTRAINT mkt_campaigns_objective_metric_chk CHECK (objective_metric IN ('LEADS','VISITS','PROPOSALS','SALES')),
        CONSTRAINT mkt_campaigns_target_value_chk CHECK (target_value > 0),
        CONSTRAINT mkt_campaigns_budget_amount_chk CHECK (budget_amount >= 0),
        CONSTRAINT mkt_campaigns_budget_justification_chk CHECK (budget_amount > 0 OR char_length(btrim(coalesce(budget_justification, ''))) > 0),
        CONSTRAINT mkt_campaigns_cost_actual_chk CHECK (cost_actual >= 0),
        CONSTRAINT mkt_campaigns_channels_chk CHECK (channels <@ ARRAY[${list(CHANNELS)}]::text[]),
        CONSTRAINT mkt_campaigns_status_chk CHECK (status IN ('DRAFT','SCHEDULED','RUNNING','ENDED')),
        CONSTRAINT mkt_campaigns_period_chk CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_campaigns_company_status_idx ON marketing.campaigns (company_id, status) WHERE deleted_at IS NULL');
      await q('CREATE INDEX IF NOT EXISTS mkt_campaigns_owner_idx ON marketing.campaigns (owner_user_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_campaigns_group_idx ON marketing.campaigns (group_id)');

      await q(`CREATE TABLE IF NOT EXISTS marketing.templates (${common}
        code varchar(80) NOT NULL,
        version_no integer NOT NULL,
        kind varchar(16) NOT NULL,
        channel varchar(16) NULL,
        status varchar(12) NOT NULL DEFAULT 'DRAFT',
        body text NOT NULL,
        variables_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        brand_tokens_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        official_template_ref varchar(200) NULL,
        content_hash char(64) NOT NULL,${audit},
        CONSTRAINT mkt_templates_company_code_version_uq UNIQUE (company_id, code, version_no),
        CONSTRAINT mkt_templates_id_company_uq UNIQUE (id, company_id),
        CONSTRAINT mkt_templates_code_chk CHECK (length(btrim(code)) > 0),
        CONSTRAINT mkt_templates_version_no_chk CHECK (version_no >= 1),
        CONSTRAINT mkt_templates_kind_chk CHECK (kind IN ('CONTENT','MESSAGE')),
        CONSTRAINT mkt_templates_channel_chk CHECK (channel IS NULL OR channel IN (${list(CHANNELS)})),
        CONSTRAINT mkt_templates_status_chk CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
        CONSTRAINT mkt_templates_content_hash_chk CHECK (content_hash ~ ${HASH_RE})
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_templates_company_status_idx ON marketing.templates (company_id, status) WHERE deleted_at IS NULL');
      await q('CREATE INDEX IF NOT EXISTS mkt_templates_group_idx ON marketing.templates (group_id)');

      await q(`CREATE TABLE IF NOT EXISTS marketing.content_items (${common}
        type varchar(32) NOT NULL,
        title varchar(300) NOT NULL,
        status varchar(24) NOT NULL DEFAULT 'DRAFT',
        source_entity_type varchar(80) NULL,
        source_entity_id uuid NULL,
        source_version integer NULL,
        current_version_id uuid NULL,
        nay_run_id uuid NULL,
        autopublish_class varchar(120) NULL,
        campaign_id uuid NULL,
        updates_content_item_id uuid NULL,
        superseded_by uuid NULL,${audit},
        CONSTRAINT mkt_content_items_id_company_uq UNIQUE (id, company_id),
        CONSTRAINT mkt_content_items_type_chk CHECK (type IN (${list(CONTENT_TYPES)})),
        CONSTRAINT mkt_content_items_title_chk CHECK (length(btrim(title)) > 0),
        CONSTRAINT mkt_content_items_status_chk CHECK (status IN (${list(CONTENT_STATUS)})),
        CONSTRAINT mkt_content_items_source_version_chk CHECK (source_version IS NULL OR source_version >= 0),
        CONSTRAINT mkt_content_items_campaign_fk FOREIGN KEY (campaign_id, company_id)
          REFERENCES marketing.campaigns (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT mkt_content_items_updates_fk FOREIGN KEY (updates_content_item_id, company_id)
          REFERENCES marketing.content_items (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT mkt_content_items_superseded_fk FOREIGN KEY (superseded_by, company_id)
          REFERENCES marketing.content_items (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_content_items_company_status_idx ON marketing.content_items (company_id, status) WHERE deleted_at IS NULL');
      await q('CREATE INDEX IF NOT EXISTS mkt_content_items_campaign_idx ON marketing.content_items (campaign_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_content_items_source_idx ON marketing.content_items (company_id, source_entity_type, source_entity_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_content_items_updates_idx ON marketing.content_items (updates_content_item_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_content_items_group_idx ON marketing.content_items (group_id)');

      await q(`CREATE TABLE IF NOT EXISTS marketing.content_versions (${common}
        content_item_id uuid NOT NULL,
        version_no integer NOT NULL,
        body_json jsonb NOT NULL,
        facts_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        facts_hash char(64) NULL,
        template_id uuid NULL,
        template_version_no integer NULL,
        model_name varchar(120) NULL,
        nay_run_id uuid NULL,
        checks_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        content_hash char(64) NOT NULL,
        approved_by varchar(160) NULL,
        approved_at timestamptz NULL,
        approved_hash char(64) NULL,${audit},
        CONSTRAINT mkt_content_versions_item_version_uq UNIQUE (content_item_id, version_no),
        CONSTRAINT mkt_content_versions_id_company_uq UNIQUE (id, company_id),
        CONSTRAINT mkt_content_versions_version_no_chk CHECK (version_no >= 1),
        CONSTRAINT mkt_content_versions_content_hash_chk CHECK (content_hash ~ ${HASH_RE}),
        CONSTRAINT mkt_content_versions_facts_hash_chk CHECK (facts_hash IS NULL OR facts_hash ~ ${HASH_RE}),
        CONSTRAINT mkt_content_versions_approved_hash_chk CHECK (approved_hash IS NULL OR approved_hash ~ ${HASH_RE}),
        CONSTRAINT mkt_content_versions_item_fk FOREIGN KEY (content_item_id, company_id)
          REFERENCES marketing.content_items (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT mkt_content_versions_template_fk FOREIGN KEY (template_id, company_id)
          REFERENCES marketing.templates (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_content_versions_company_item_idx ON marketing.content_versions (company_id, content_item_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_content_versions_template_idx ON marketing.content_versions (template_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_content_versions_group_idx ON marketing.content_versions (group_id)');

      // A versão corrente do item (ciclo item <-> versão): FK adiada até o fim da transação.
      await q(`DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_content_items_current_version_fk' AND conrelid = 'marketing.content_items'::regclass) THEN
            ALTER TABLE marketing.content_items ADD CONSTRAINT mkt_content_items_current_version_fk
              FOREIGN KEY (current_version_id, company_id) REFERENCES marketing.content_versions (id, company_id)
              ON UPDATE CASCADE ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
          END IF;
        END $$`);

      await q(`CREATE TABLE IF NOT EXISTS marketing.campaign_audiences (${common}
        campaign_id uuid NOT NULL,
        kind varchar(16) NOT NULL,
        filter_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        purpose varchar(40) NOT NULL,
        size_frozen integer NULL,
        frozen_at timestamptz NULL,${audit},
        CONSTRAINT mkt_campaign_audiences_kind_chk CHECK (kind IN ('SEGMENT','PERSON_LIST','RADAR_MATCH')),
        CONSTRAINT mkt_campaign_audiences_purpose_chk CHECK (length(btrim(purpose)) > 0),
        CONSTRAINT mkt_campaign_audiences_size_chk CHECK (size_frozen IS NULL OR size_frozen >= 0),
        CONSTRAINT mkt_campaign_audiences_campaign_fk FOREIGN KEY (campaign_id, company_id)
          REFERENCES marketing.campaigns (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_campaign_audiences_campaign_idx ON marketing.campaign_audiences (company_id, campaign_id) WHERE deleted_at IS NULL');
      await q('CREATE INDEX IF NOT EXISTS mkt_campaign_audiences_group_idx ON marketing.campaign_audiences (group_id)');

      await q(`CREATE TABLE IF NOT EXISTS marketing.campaign_steps (${common}
        campaign_id uuid NOT NULL,
        step_no integer NOT NULL,
        channel varchar(16) NOT NULL,
        template_id uuid NOT NULL,
        content_item_id uuid NULL,
        offset_minutes integer NOT NULL DEFAULT 0,
        status varchar(12) NOT NULL DEFAULT 'PLANNED',${audit},
        CONSTRAINT mkt_campaign_steps_campaign_step_uq UNIQUE (campaign_id, step_no),
        CONSTRAINT mkt_campaign_steps_step_no_chk CHECK (step_no >= 1),
        CONSTRAINT mkt_campaign_steps_channel_chk CHECK (channel IN (${list(CHANNELS)})),
        CONSTRAINT mkt_campaign_steps_offset_chk CHECK (offset_minutes >= 0),
        CONSTRAINT mkt_campaign_steps_status_chk CHECK (status IN ('PLANNED','SCHEDULED','SENT','SKIPPED','CANCELLED')),
        CONSTRAINT mkt_campaign_steps_campaign_fk FOREIGN KEY (campaign_id, company_id)
          REFERENCES marketing.campaigns (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT mkt_campaign_steps_template_fk FOREIGN KEY (template_id, company_id)
          REFERENCES marketing.templates (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT mkt_campaign_steps_content_fk FOREIGN KEY (content_item_id, company_id)
          REFERENCES marketing.content_items (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_campaign_steps_company_status_idx ON marketing.campaign_steps (company_id, status) WHERE deleted_at IS NULL');
      await q('CREATE INDEX IF NOT EXISTS mkt_campaign_steps_template_idx ON marketing.campaign_steps (template_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_campaign_steps_content_idx ON marketing.campaign_steps (content_item_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_campaign_steps_group_idx ON marketing.campaign_steps (group_id)');

      // Versão de conteúdo imutável.
      await q(`CREATE OR REPLACE FUNCTION marketing.content_versions_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW.body_json IS DISTINCT FROM OLD.body_json
             OR NEW.facts_snapshot_json IS DISTINCT FROM OLD.facts_snapshot_json
             OR NEW.facts_hash IS DISTINCT FROM OLD.facts_hash
             OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
             OR NEW.content_item_id IS DISTINCT FROM OLD.content_item_id
             OR NEW.version_no IS DISTINCT FROM OLD.version_no
             OR NEW.template_id IS DISTINCT FROM OLD.template_id
             OR NEW.template_version_no IS DISTINCT FROM OLD.template_version_no
             OR NEW.model_name IS DISTINCT FROM OLD.model_name
             OR NEW.nay_run_id IS DISTINCT FROM OLD.nay_run_id THEN
            RAISE EXCEPTION 'MKT_CONTENT_VERSION_IMMUTABLE: a versão do conteúdo é imutável; crie uma nova versão.' USING ERRCODE = 'MK001';
          END IF;
          RETURN NEW;
        END
        $fn$`);
      await q('DROP TRIGGER IF EXISTS content_versions_immutable ON marketing.content_versions');
      await q(`CREATE TRIGGER content_versions_immutable BEFORE UPDATE ON marketing.content_versions
        FOR EACH ROW EXECUTE FUNCTION marketing.content_versions_immutable()`);

      // RLS FORCE por grupo e empresa, fail-closed (sem contexto: nenhuma linha e nenhum INSERT).
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
        // Sem DELETE: a exclusão é lógica (deleted_at).
        await q(`GRANT SELECT, INSERT, UPDATE ON ${TABLES.map((t) => `marketing.${t}`).join(', ')} TO nayara_runtime`);
      }
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      for (const t of TABLES) {
        const [[{ reg }]] = await sequelize.query(`SELECT to_regclass('marketing.${t}') AS reg`, { transaction });
        if (!reg) continue;
        const [[{ n }]] = await sequelize.query(`SELECT count(*)::int AS n FROM marketing.${t}`, { transaction });
        if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: marketing.${t} não está vazia (${n} linhas); o down não apaga dados.`);
      }
      await q('ALTER TABLE IF EXISTS marketing.content_items DROP CONSTRAINT IF EXISTS mkt_content_items_current_version_fk');
      for (const t of ['campaign_steps', 'campaign_audiences', 'content_versions', 'content_items', 'templates', 'campaigns']) {
        await q(`DROP TABLE IF EXISTS marketing.${t}`);
      }
      await q('DROP FUNCTION IF EXISTS marketing.content_versions_immutable()');
      const [[{ restantes }]] = await sequelize.query(
        `SELECT count(*)::int AS restantes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'marketing' AND c.relkind IN ('r','v','m','S','f','p')`, { transaction });
      if (restantes === 0) await q('DROP SCHEMA IF EXISTS marketing');
    });
  },
};
