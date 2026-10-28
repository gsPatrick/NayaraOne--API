'use strict';

/**
 * Marco 9, demanda M9-D700 (BI-009): 12 permissões `analytics:*` e o log de acesso do BI.
 *
 * - Permissões: idempotentes por código (mesma lista de src/modules/analytics/security/permissionCatalog.js; o teste confere).
 *   O papel ADMIN de cada empresa recebe as 12; os demais papéis recebem o que o administrador concede (nada é retirado).
 * - analytics.access_log: uma linha por acesso sensível (usuário, empresa, rota, painel/métrica, filtro, linhas, mascaramento,
 *   IP hasheado, correlation_id, instante). IMUTÁVEL: o role de runtime só tem SELECT e INSERT; as políticas RLS são só de
 *   SELECT e INSERT (sem política de UPDATE/DELETE = negado); o gatilho recusa UPDATE para todos e DELETE salvo com a marca
 *   `app.analytics_log_retention = on` (expurgo da governança de dados, Bloco F, executado pelo dono da tabela).
 * RLS ENABLE + FORCE. GRANT ao nayara_runtime dentro de guarda de existência do role. Idempotente. Faixa do BI: 9600 a 9709.
 */
const { ANALYTICS_PERMISSIONS, ANALYTICS_PERMISSION_CODES } = require('../src/modules/analytics/security/permissionCatalog');

const T = '"analytics"."access_log"';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const ACTIONS = ['DASHBOARD_OPEN', 'METRIC_READ', 'DRILLDOWN', 'EXPORT_REQUEST', 'EXPORT_GENERATE', 'EXPORT_DOWNLOAD', 'BRIEF_GENERATE', 'BRIEF_READ', 'NAY_QUERY'];

async function seedPermissions(q) {
  for (const [code, description, risk] of ANALYTICS_PERMISSIONS) {
    await q(
      `INSERT INTO core.permissions (id, code, description, risk_level, created_at, updated_at)
       SELECT gen_random_uuid(), :code, :description, :risk, now(), now()
        WHERE NOT EXISTS (SELECT 1 FROM core.permissions WHERE code = :code)`,
      { code, description, risk }
    );
  }
  // core.companies e core.roles têm FORCE RLS: a concessão entre empresas desliga o FORCE só aqui e religa no finally.
  await q('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
  await q('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
  try {
    await q(
      `INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
       SELECT gen_random_uuid(), r.id, p.id, now(), now()
         FROM core.roles r CROSS JOIN core.permissions p
        WHERE r.deleted_at IS NULL AND r.name = 'ADMIN' AND p.code = ANY(ARRAY[:codes])
          AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`,
      { codes: ANALYTICS_PERMISSION_CODES }
    );
  } finally {
    await q('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
    await q('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
  }
}

async function createAccessLog(q) {
  await q(`
    CREATE TABLE IF NOT EXISTS ${T} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      user_id uuid NULL,
      action text NOT NULL,
      route text NULL,
      resource_type text NOT NULL,
      resource_code text NULL,
      filters jsonb NOT NULL DEFAULT '{}'::jsonb,
      rows_returned integer NOT NULL DEFAULT 0,
      masking_applied boolean NOT NULL DEFAULT false,
      ip_hash text NULL,
      correlation_id text NULL,
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT access_log_action_valid CHECK (action IN (${ACTIONS.map((a) => `'${a}'`).join(', ')})),
      CONSTRAINT access_log_rows_nonneg CHECK (rows_returned >= 0),
      CONSTRAINT access_log_filters_object CHECK (jsonb_typeof(filters) = 'object'),
      CONSTRAINT access_log_resource_not_blank CHECK (length(btrim(resource_type)) > 0)
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS access_log_company_time_idx ON ${T} (company_id, occurred_at DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS access_log_user_idx ON ${T} (company_id, user_id, occurred_at DESC)`);
  await q(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`);
  await q(`ALTER TABLE ${T} FORCE ROW LEVEL SECURITY`);
  for (const name of ['analytics_select', 'analytics_insert', 'analytics_update', 'analytics_delete']) {
    await q(`DROP POLICY IF EXISTS ${name} ON ${T}`);
  }
  await q(`CREATE POLICY analytics_select ON ${T} FOR SELECT USING (company_id = ${COMPANY_GUC})`);
  await q(`CREATE POLICY analytics_insert ON ${T} FOR INSERT WITH CHECK (company_id = ${COMPANY_GUC} AND group_id = ${GROUP_GUC})`);
  await q(`
    CREATE OR REPLACE FUNCTION analytics.access_log_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' AND COALESCE(current_setting('app.analytics_log_retention', true), '') = 'on' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'O log de acesso do BI não pode ser alterado nem apagado.' USING ERRCODE = 'ANA20';
    END
    $fn$
  `);
  await q(`DROP TRIGGER IF EXISTS access_log_guard ON ${T}`);
  await q(`CREATE TRIGGER access_log_guard BEFORE UPDATE OR DELETE ON ${T} FOR EACH ROW EXECUTE FUNCTION analytics.access_log_guard()`);
  await q(`
    DO $do$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        GRANT USAGE ON SCHEMA "analytics" TO nayara_runtime;
        GRANT SELECT, INSERT ON ${T} TO nayara_runtime;
      END IF;
    END
    $do$
  `);
}

module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await seedPermissions(q);
      await createAccessLog(q);
    });
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q(`DROP TABLE IF EXISTS ${T}`);
      await q('DROP FUNCTION IF EXISTS analytics.access_log_guard()');
      await q('DELETE FROM core.role_permissions WHERE permission_id IN (SELECT id FROM core.permissions WHERE code = ANY(ARRAY[:codes]))', { codes: ANALYTICS_PERMISSION_CODES });
      await q('DELETE FROM core.permissions WHERE code = ANY(ARRAY[:codes])', { codes: ANALYTICS_PERMISSION_CODES });
    });
  },
};
