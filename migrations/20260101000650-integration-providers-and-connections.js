'use strict';

/**
 * Marco 9, M9-D200 — registro de integração: integration.providers (catálogo global) e
 * integration.connections (por empresa e ambiente, sem segredo bruto: só secret_ref).
 *
 * Também migra correspondent.provider_accounts para connections (domínio FINANCING) de forma
 * idempotente e deixa a tabela antiga como legado somente leitura (gatilho recusa escrita).
 */
const DOMAINS = ['MESSAGING', 'EMAIL', 'SITE', 'PORTAL', 'SIGNATURE', 'BANK', 'INSURANCE', 'FINANCING', 'FISCAL', 'SOCIAL', 'STORAGE', 'IDENTITY', 'AI', 'ANALYTICS'];

const BACKFILL_SQL = `
INSERT INTO "integration"."connections"
  (id, group_id, company_id, provider_code, environment, label, status, secret_ref, config_json, policy_json, created_by, updated_by, created_at, updated_at)
SELECT s.id, s.group_id, s.company_id, lower(s.provider_code), 'SANDBOX',
       CASE WHEN s.rn = 1 THEN s.label ELSE left(s.label, 74) || ' (' || s.rn || ')' END,
       CASE WHEN NOT s.active THEN 'DISABLED' WHEN s.ordem_ativa = 1 THEN 'ACTIVE' ELSE 'PAUSED' END,
       s.secret_ref, '{}'::jsonb, '{}'::jsonb, s.created_by, s.created_by, s.created_at, s.updated_at
FROM (
  SELECT a.*,
         row_number() OVER (PARTITION BY a.company_id, lower(a.provider_code), lower(a.label)
                            ORDER BY a.active DESC, a.created_at, a.id) AS rn,
         CASE WHEN a.active THEN row_number() OVER (PARTITION BY a.company_id, lower(a.provider_code), a.active
                                                    ORDER BY a.created_at, a.id) END AS ordem_ativa
  FROM "correspondent"."provider_accounts" a
  WHERE lower(a.provider_code) ~ '^[a-z0-9_-]{1,48}$'
) s
ON CONFLICT DO NOTHING;
`;

module.exports = {
  BACKFILL_SQL,
  up: async (queryInterface) => {
    const q = (sql, opts) => queryInterface.sequelize.query(sql, opts);
    const domainList = DOMAINS.map((d) => `'${d}'`).join(', ');

    await q(`
      CREATE TABLE "integration"."providers" (
        code varchar(48) PRIMARY KEY CHECK (code ~ '^[a-z0-9_-]+$'),
        display_name varchar(120) NOT NULL,
        domain varchar(24) NOT NULL CHECK (domain IN (${domainList})),
        capabilities jsonb NOT NULL CHECK (jsonb_typeof(capabilities) = 'array'),
        supported_versions jsonb NOT NULL CHECK (jsonb_typeof(supported_versions) = 'array'),
        criticality varchar(10) NOT NULL CHECK (criticality IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
        status varchar(12) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DEPRECATED', 'DISABLED')),
        default_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        config_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
        sandbox_available boolean NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q(`CREATE INDEX providers_domain_idx ON "integration"."providers" (domain, status);`);

    await q(`
      CREATE TABLE "integration"."connections" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        provider_code varchar(48) NOT NULL REFERENCES "integration"."providers"(code) ON DELETE RESTRICT ON UPDATE CASCADE,
        environment varchar(10) NOT NULL CHECK (environment IN ('SANDBOX', 'HOMOLOG', 'PRODUCTION')),
        label varchar(80) NOT NULL,
        status varchar(14) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'AUTH_FAILED', 'DISABLED')),
        secret_ref varchar(160),
        config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        api_version varchar(16),
        webhook_channel varchar(48),
        policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        production_released_at timestamptz,
        production_released_by uuid,
        last_secret_rotation_at timestamptz,
        secret_expires_at timestamptz,
        created_by uuid,
        updated_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT connections_production_released_check
          CHECK (NOT (environment = 'PRODUCTION' AND status = 'ACTIVE' AND production_released_at IS NULL))
      );
    `);
    await q(`CREATE UNIQUE INDEX connections_label_unique ON "integration"."connections" (company_id, provider_code, environment, label);`);
    await q(`CREATE UNIQUE INDEX connections_one_active ON "integration"."connections" (company_id, provider_code, environment) WHERE status = 'ACTIVE';`);
    await q(`CREATE UNIQUE INDEX connections_webhook_channel_unique ON "integration"."connections" (provider_code, webhook_channel) WHERE webhook_channel IS NOT NULL;`);
    await q(`CREATE INDEX connections_company_idx ON "integration"."connections" (company_id, status);`);

    // providers: DELETE proibido (só status DISABLED) e escrita só com a marca de administração de plataforma.
    await q(`
      CREATE FUNCTION "integration".providers_no_delete() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        RAISE EXCEPTION 'integration.providers não admite DELETE: use status DISABLED' USING ERRCODE = 'restrict_violation';
      END $f$;
    `);
    await q(`CREATE TRIGGER providers_no_delete BEFORE DELETE ON "integration"."providers" FOR EACH ROW EXECUTE FUNCTION "integration".providers_no_delete();`);

    // connections: DISABLED não volta a nenhum outro status (cria-se outra connection).
    await q(`
      CREATE FUNCTION "integration".connections_disabled_final() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF OLD.status = 'DISABLED' AND NEW.status <> 'DISABLED' THEN
          RAISE EXCEPTION 'connection DISABLED não pode voltar a %', NEW.status USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $f$;
    `);
    await q(`CREATE TRIGGER connections_disabled_final BEFORE UPDATE ON "integration"."connections" FOR EACH ROW EXECUTE FUNCTION "integration".connections_disabled_final();`);

    // RLS
    await q(`ALTER TABLE "integration"."providers" ENABLE ROW LEVEL SECURITY;`);
    await q(`CREATE POLICY providers_read ON "integration"."providers" FOR SELECT USING (true);`);
    await q(`CREATE POLICY providers_platform_insert ON "integration"."providers" FOR INSERT
      WITH CHECK (current_setting('app.integration_platform_admin', true) = 'on');`);
    await q(`CREATE POLICY providers_platform_update ON "integration"."providers" FOR UPDATE
      USING (current_setting('app.integration_platform_admin', true) = 'on')
      WITH CHECK (current_setting('app.integration_platform_admin', true) = 'on');`);

    await q(`ALTER TABLE "integration"."connections" ENABLE ROW LEVEL SECURITY;`);
    await q(`CREATE POLICY tenant_isolation ON "integration"."connections"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);

    // Providers que o Correspondente já usa (adapters sandbox e manual).
    await q(`
      INSERT INTO "integration"."providers" (code, display_name, domain, capabilities, supported_versions, criticality, status, sandbox_available)
      VALUES
        ('sandbox', 'Financiamento (sandbox)', 'FINANCING', '["simulate","submitCase","getCaseStatus","uploadDocument","requestAppraisal","verifyWebhook"]', '["v1"]', 'MEDIUM', 'ACTIVE', true),
        ('manual', 'Financiamento (fluxo manual assistido)', 'FINANCING', '["submitCase","getCaseStatus"]', '["v1"]', 'LOW', 'ACTIVE', false)
      ON CONFLICT (code) DO NOTHING;
    `);
    // Backfill (a tabela de origem tem FORCE RLS: o dono não enxerga linhas sem empresa; liberamos só durante a cópia).
    await q(`ALTER TABLE "correspondent"."provider_accounts" NO FORCE ROW LEVEL SECURITY;`);
    try {
      // Códigos legados fora do catálogo viram provider FINANCING para a conta não se perder.
      await q(`
        INSERT INTO "integration"."providers" (code, display_name, domain, capabilities, supported_versions, criticality, status, sandbox_available)
        SELECT DISTINCT lower(provider_code), lower(provider_code), 'FINANCING', '[]'::jsonb, '["v1"]'::jsonb, 'MEDIUM', 'ACTIVE', false
        FROM "correspondent"."provider_accounts" WHERE lower(provider_code) ~ '^[a-z0-9_-]{1,48}$'
        ON CONFLICT (code) DO NOTHING;
      `);

      await q(BACKFILL_SQL);
    } finally {
      await q(`ALTER TABLE "correspondent"."provider_accounts" FORCE ROW LEVEL SECURITY;`);
    }
    await q(`ALTER TABLE "integration"."connections" FORCE ROW LEVEL SECURITY;`);

    // O gatilho de somente leitura do legado NÃO nasce aqui: ele é criado pela migration 20260101009964 (última), junto com o deploy da API do Marco 9.

    const [[{ exists }]] = await q("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
    if (exists) {
      await q('GRANT SELECT, INSERT, UPDATE ON "integration"."providers" TO nayara_runtime;');
      await q('GRANT SELECT, INSERT, UPDATE, DELETE ON "integration"."connections" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TRIGGER IF EXISTS provider_accounts_read_only ON "correspondent"."provider_accounts";');
    await q('DROP FUNCTION IF EXISTS "correspondent".provider_accounts_read_only();');
    await q('DROP TABLE IF EXISTS "integration"."connections";');
    await q('DROP TABLE IF EXISTS "integration"."providers";');
    await q('DROP FUNCTION IF EXISTS "integration".connections_disabled_final();');
    await q('DROP FUNCTION IF EXISTS "integration".providers_no_delete();');
  },
};
